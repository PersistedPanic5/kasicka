// debt-file — gives the PUBLIC debt page a short-lived link to one attachment.
//   POST { "token": "<share token>", "file_id": "<uuid | tx:<uuid>>" }
//   -> { "url": "<signed url, 5 min>", "name": "...", "mime": "..." }
// The receipts bucket is private. The database function debt_file_path()
// (migration 0020) only returns a path when file_id is listed in what
// get_debt_bill(token) shows for that link, so a token can never open a file
// that does not belong on its page. Anonymous callers, service role inside.

import { createClient } from 'npm:@supabase/supabase-js@2.55.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let body: { token?: unknown; file_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const { token, file_id } = body;
  if (typeof token !== 'string' || typeof file_id !== 'string' || token.length > 100 || file_id.length > 100) {
    return json({ error: 'bad request' }, 400);
  }
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: path, error } = await svc.rpc('debt_file_path', { p_token: token, p_file_id: file_id });
  if (error || !path) return json({ error: 'not found' }, 404);
  const { data, error: e2 } = await svc.storage.from('receipts').createSignedUrl(path as string, 300);
  if (e2 || !data) return json({ error: 'not found' }, 404);
  return json({ url: data.signedUrl });
});
