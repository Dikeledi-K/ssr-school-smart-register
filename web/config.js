// SSR – School Smart Register : connection settings
// Fill these in from Supabase → Project Settings → API (or "Connect").
// The anon/public key is safe to put here: the database rules decide what each login can see.
window.SSR_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
  // Must match TEACHER_DOMAIN in supabase/functions/ssr-admin/index.ts. Leave as is.
  TEACHER_DOMAIN: "teachers.ssr.local",
};
