import type { RequestContext } from "./http.ts";

export type RouteHandler = (context: RequestContext) => Promise<Response> | Response;
export type Middleware = (handler: RouteHandler) => RouteHandler;

interface CompiledRoute {
  method: string;
  path: string;
  keys: string[];
  regex: RegExp;
  handler: RouteHandler;
}

function normalisePath(path: string): string {
  const withLeading = path.startsWith("/") ? path : `/${path}`;
  if (withLeading.length > 1 && withLeading.endsWith("/")) {
    return withLeading.replace(/\/+$/, "");
  }
  return withLeading;
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(path: string): { keys: string[]; regex: RegExp } {
  const keys: string[] = [];
  const segments = normalisePath(path).split("/").filter((segment) => segment.length > 0);

  const pattern = segments
    .map((segment) => {
      if (segment.startsWith(":")) {
        const key = segment.slice(1);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          throw new Error(`Invalid route parameter: ${segment}`);
        }
        keys.push(key);
        return "([^/]+)";
      }
      return escapeLiteral(segment);
    })
    .join("/");

  return {
    keys,
    regex: new RegExp(`^/${pattern}/?$`),
  };
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(method: string, path: string, handler: RouteHandler): this {
    const { keys, regex } = compile(path);
    this.routes.push({
      method: method.toUpperCase(),
      path: normalisePath(path),
      keys,
      regex,
      handler,
    });
    return this;
  }

  get(path: string, handler: RouteHandler): this {
    return this.add("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.add("POST", path, handler);
  }

  patch(path: string, handler: RouteHandler): this {
    return this.add("PATCH", path, handler);
  }

  delete(path: string, handler: RouteHandler): this {
    return this.add("DELETE", path, handler);
  }

  match(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const normalised = normalisePath(pathname);

    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const match = route.regex.exec(normalised);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        const raw = match[index + 1] ?? "";
        try {
          params[key] = decodeURIComponent(raw);
        } catch {
          params[key] = raw;
        }
      });

      return { handler: route.handler, params };
    }

    return null;
  }

  allowedMethods(pathname: string): string[] {
    const normalised = normalisePath(pathname);
    const methods = new Set<string>();
    for (const route of this.routes) {
      if (route.regex.test(normalised)) methods.add(route.method);
    }
    return [...methods];
  }
}
