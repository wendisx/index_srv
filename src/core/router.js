/**
 * 极简路由器：支持 /api/sites/:id 形式的路由参数。
 * 路由按注册顺序匹配，因此静态路径需先于参数路径注册。
 */
function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');

  return { regexp: new RegExp(`^${source}/?$`), keys };
}

export class Router {
  #routes = [];

  add(method, pattern, handler) {
    const { regexp, keys } = compile(pattern);
    this.#routes.push({ method: method.toUpperCase(), regexp, keys, handler });
  }

  get(pattern, handler) {
    this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    this.add('POST', pattern, handler);
  }

  put(pattern, handler) {
    this.add('PUT', pattern, handler);
  }

  patch(pattern, handler) {
    this.add('PATCH', pattern, handler);
  }

  /**
   * @returns {{ handler: Function, params: Record<string,string> } | { allow: string[] } | null}
   */
  match(method, pathname) {
    const allowed = new Set();
    for (const route of this.#routes) {
      const matched = route.regexp.exec(pathname);
      if (!matched) continue;
      if (route.method !== method.toUpperCase()) {
        allowed.add(route.method);
        continue;
      }
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(matched[index + 1] ?? '');
      });
      return { handler: route.handler, params };
    }
    return allowed.size > 0 ? { allow: [...allowed] } : null;
  }
}
