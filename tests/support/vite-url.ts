import { fileURLToPath } from 'node:url';

/** Vite's absolute filesystem URL uses forward slashes on every host. */
export function viteFileUrl(url: URL): string {
  const path = fileURLToPath(url).replaceAll('\\', '/');
  return '/@fs/' + path.replace(/^\//, '').split('/').map(part => encodeURIComponent(part).replace('%3A', ':')).join('/');
}
