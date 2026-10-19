// A small public file lets the host announce a restarted tunnel without a site rebuild.
export function validBackend(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !['', '/', '/stemroom', '/stemroom/'].includes(url.pathname)) return null;
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}

export async function readConnection(url, fetcher = fetch) {
  try {
    const response = await fetcher(url, {cache: 'no-store', signal: AbortSignal.timeout(4000)});
    if (!response.ok) return null;
    return validBackend((await response.json()).backendUrl);
  } catch { return null; }
}
