-- =====================================================================
-- SSR – School Smart Register : Supabase database
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it drops and recreates the SSR objects (and their data!).
-- =====================================================================

-- ---------- clean slate (comment this block out after go-live) ----------
drop table if exists public.meals cascade;
drop table if exists public.attendance cascade;
drop table if exists public.learners cascade;
drop table if exists public.profiles cascade;
drop table if exists public.schools cascade;

-- ---------- tables ----------
-- Class names: grade R or 1–12, then 0–3 letters.  Examples: RA, 5A, 12B, 7
create table public.schools (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 2 and 120),
  code        text not null unique check (code ~ '^[A-Z0-9]{3,12}$'),
  created_at  timestamptz not null default now()
);

create table public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  school_id      uuid not null references public.schools(id) on delete cascade,
  role           text not null check (role in ('admin','teacher')),
  username       text not null check (length(trim(username)) between 2 and 60),
  -- "Baloyi T.K" and "baloyi tk" are the same username
  username_key   text generated always as (regexp_replace(lower(username), '[^a-z0-9]+', '', 'g')) stored,
  main_class     text check (main_class is null or main_class ~ '^(R|[1-9]|1[0-2])[A-Z]{0,3}$'),
  subject        text not null default '' check (length(subject) <= 80),
  period_classes text[] not null default '{}' check (cardinality(period_classes) <= 10),
  created_at     timestamptz not null default now(),
  check (role = 'admin' or main_class is not null)
);
create unique index profiles_username_uq on public.profiles (school_id, username_key);
create unique index profiles_class_uq    on public.profiles (school_id, main_class) where role = 'teacher';

create table public.learners (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools(id) on delete cascade,
  class       text not null check (class ~ '^(R|[1-9]|1[0-2])[A-Z]{0,3}$'),
  surname     text not null check (length(trim(surname)) between 1 and 60),
  name        text not null check (length(trim(name)) between 1 and 80),
  gender      text not null check (gender in ('M','F')),
  contact1    text not null default '' check (contact1 ~ '^[0-9+ ()-]{0,20}$'),
  contact2    text not null default '' check (contact2 ~ '^[0-9+ ()-]{0,20}$'),
  created_at  timestamptz not null default now()
);
create index learners_class_idx on public.learners (school_id, class);

-- One row per class per day (daily, period 0) or per class per day per period (period register)
create table public.attendance (
  school_id   uuid not null references public.schools(id) on delete cascade,
  kind        text not null check (kind in ('D','P')),
  class       text not null,
  day         date not null check (extract(isodow from day) between 1 and 5),
  period      smallint not null default 0,
  subject     text not null default '',
  absent      uuid[] not null default '{}',
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (school_id, kind, class, day, period),
  check ((kind = 'D' and period = 0) or (kind = 'P' and period between 1 and 15))
);

create table public.meals (
  school_id        uuid not null references public.schools(id) on delete cascade,
  class            text not null,
  day              date not null check (extract(isodow from day) between 1 and 5),
  breakfast        boolean not null default false,
  main_meal        boolean not null default true,
  breakfast_served int check (breakfast_served >= 0),
  main_served      int check (main_served >= 0),
  updated_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (school_id, class, day)
);

-- ---------- helper functions (who is logged in?) ----------
create or replace function public.my_school() returns uuid
language sql stable security definer set search_path = public as
$$ select school_id from public.profiles where id = auth.uid() $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;

create or replace function public.my_class() returns text
language sql stable security definer set search_path = public as
$$ select main_class from public.profiles where id = auth.uid() and role = 'teacher' $$;

create or replace function public.my_period_classes() returns text[]
language sql stable security definer set search_path = public as
$$ select coalesce((select period_classes from public.profiles where id = auth.uid() and role = 'teacher'), '{}') $$;

-- ---------- triggers: stamp who saved, keep absent lists clean ----------
create or replace function public.attendance_clean() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  -- keep only learners that really are in this class at this school
  new.absent := coalesce((
      select array_agg(distinct u.a)
      from unnest(new.absent) as u(a)
      join public.learners l on l.id = u.a and l.school_id = new.school_id and l.class = new.class
    ), '{}');
  return new;
end $$;
create trigger attendance_clean before insert or update on public.attendance
  for each row execute function public.attendance_clean();

create or replace function public.meals_stamp() returns trigger
language plpgsql as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
create trigger meals_stamp before insert or update on public.meals
  for each row execute function public.meals_stamp();

-- ---------- Row Level Security: each school sees only its own data ----------
alter table public.schools    enable row level security;
alter table public.profiles   enable row level security;
alter table public.learners   enable row level security;
alter table public.attendance enable row level security;
alter table public.meals      enable row level security;

-- schools: members read their school; the admin may rename it (code is fixed)
create policy schools_read on public.schools for select to authenticated
  using (id = public.my_school());
create policy schools_rename on public.schools for update to authenticated
  using (id = public.my_school() and public.is_admin())
  with check (id = public.my_school() and public.is_admin());

-- profiles: you see yourself; the admin sees everyone at the school.
-- Nobody writes profiles directly: the admin uses the ssr-admin function,
-- teachers use set_teaching() (subject + period classes only).
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or (public.is_admin() and school_id = public.my_school()));

-- learners: ONLY the admin touches this table. Teachers read learners through
-- class_roster() (names + gender, no numbers) and parent_contacts() (own class).
create policy learners_admin on public.learners for all to authenticated
  using (school_id = public.my_school() and public.is_admin())
  with check (school_id = public.my_school() and public.is_admin());

-- attendance: teacher reads/writes own class (daily) and chosen period classes; admin reads all
create policy att_read on public.attendance for select to authenticated
  using (school_id = public.my_school() and (
           public.is_admin()
        or (kind = 'D' and class = public.my_class())
        or (kind = 'P' and class = any(public.my_period_classes()))));
create policy att_insert on public.attendance for insert to authenticated
  with check (school_id = public.my_school() and (
           (kind = 'D' and class = public.my_class())
        or (kind = 'P' and class = any(public.my_period_classes()))));
create policy att_update on public.attendance for update to authenticated
  using (school_id = public.my_school() and (
           (kind = 'D' and class = public.my_class())
        or (kind = 'P' and class = any(public.my_period_classes()))))
  with check (school_id = public.my_school() and (
           (kind = 'D' and class = public.my_class())
        or (kind = 'P' and class = any(public.my_period_classes()))));

-- meals: teacher reads/writes own class; admin reads all
create policy meals_read on public.meals for select to authenticated
  using (school_id = public.my_school() and (public.is_admin() or class = public.my_class()));
create policy meals_insert on public.meals for insert to authenticated
  with check (school_id = public.my_school() and class = public.my_class());
create policy meals_update on public.meals for update to authenticated
  using (school_id = public.my_school() and class = public.my_class())
  with check (school_id = public.my_school() and class = public.my_class());

-- ---------- table privileges ----------
revoke all on public.schools, public.profiles, public.learners, public.attendance, public.meals from anon, authenticated;
grant all on public.schools, public.profiles, public.learners, public.attendance, public.meals to service_role;
grant usage on schema public to authenticated;
grant select on public.schools to authenticated;
grant update (name) on public.schools to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.learners to authenticated;
grant select, insert, update on public.attendance to authenticated;
grant select, insert, update on public.meals to authenticated;

-- ---------- functions the app calls ----------
-- First step after the administrator signs up: create the school.
create or replace function public.create_school(p_name text, p_code text, p_admin_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare sid uuid; c text := upper(regexp_replace(coalesce(p_code,''), '\s', '', 'g'));
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'This account already belongs to a school.';
  end if;
  if c !~ '^[A-Z0-9]{3,12}$' then
    raise exception 'School code must be 3 to 12 letters or numbers.';
  end if;
  begin
    insert into public.schools (name, code) values (trim(p_name), c) returning id into sid;
  exception when unique_violation then
    raise exception 'That school code is already taken. Choose another.';
  end;
  insert into public.profiles (id, school_id, role, username) values (auth.uid(), sid, 'admin', trim(p_admin_name));
  return sid;
end $$;

-- Names + gender only (never phone numbers), sorted A–Z.
create or replace function public.class_roster(p_class text)
returns table (id uuid, surname text, name text, gender text)
language sql stable security definer set search_path = public as $$
  select l.id, l.surname, l.name, l.gender
  from public.learners l
  where l.school_id = public.my_school()
    and l.class = p_class
    and (public.is_admin() or p_class = public.my_class() or p_class = any(public.my_period_classes()))
  order by lower(l.surname), lower(l.name)
$$;

-- Parents tab: the teacher's own class only.
create or replace function public.parent_contacts()
returns table (id uuid, surname text, name text, gender text, contact1 text, contact2 text)
language sql stable security definer set search_path = public as $$
  select l.id, l.surname, l.name, l.gender, l.contact1, l.contact2
  from public.learners l
  where l.school_id = public.my_school() and l.class = public.my_class()
  order by lower(l.surname), lower(l.name)
$$;

-- Classes at my school (for choosing period classes), with learner counts.
create or replace function public.school_classes()
returns table (class text, learners int)
language sql stable security definer set search_path = public as $$
  select c.class, (select count(*)::int from public.learners l where l.school_id = public.my_school() and l.class = c.class)
  from (
    select distinct class from public.learners where school_id = public.my_school()
    union
    select main_class from public.profiles where school_id = public.my_school() and main_class is not null
  ) c
  where public.my_school() is not null
  order by length(regexp_replace(c.class, '[A-Z]+$', '')), c.class
$$;

-- Teacher sets the subject they teach and up to 10 period classes (never their own fixed class).
create or replace function public.set_teaching(p_subject text, p_classes text[])
returns void language plpgsql security definer set search_path = public as $$
declare cl text[];
begin
  select coalesce(array_agg(distinct x), '{}') into cl from unnest(coalesce(p_classes, '{}')) x where x is not null and x <> '';
  if cardinality(cl) > 10 then raise exception 'Choose up to 10 classes.'; end if;
  if exists (select 1 from unnest(cl) x where x !~ '^(R|[1-9]|1[0-2])[A-Z]{0,3}$') then
    raise exception 'Unknown class name.';
  end if;
  update public.profiles set subject = left(trim(coalesce(p_subject, '')), 80), period_classes = cl
  where id = auth.uid() and role = 'teacher';
  if not found then raise exception 'Only teachers can do this.'; end if;
end $$;

revoke execute on function public.create_school(text,text,text), public.class_roster(text), public.parent_contacts(),
  public.school_classes(), public.set_teaching(text,text[]), public.my_school(), public.is_admin(),
  public.my_class(), public.my_period_classes() from public, anon;
grant execute on function public.create_school(text,text,text), public.class_roster(text), public.parent_contacts(),
  public.school_classes(), public.set_teaching(text,text[]), public.my_school(), public.is_admin(),
  public.my_class(), public.my_period_classes() to authenticated;
