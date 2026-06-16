// react-router v6 -> @tanstack/react-router compat shim (phase 3b).
//
// TanStack Router exposes search params as a typed object via `useSearch`,
// not as a `URLSearchParams` + setter tuple like react-router's
// `useSearchParams()`. Rather than rewrite all 14 call sites onto typed
// search, this hook mirrors react-router's `[URLSearchParams, setSearchParams]`
// API on top of TanStack so each call site only swaps its import.
//
// Routes that read search are given `validateSearch: (s) => s` (passthrough),
// so arbitrary params survive a round trip through the router.
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';

type SetSearchParamsArg =
  | URLSearchParams
  | string
  | Record<string, string>
  | ((prev: URLSearchParams) => URLSearchParams | string | Record<string, string>);

type SetSearchParamsOptions = { replace?: boolean };

type SetSearchParams = (
  next: SetSearchParamsArg,
  options?: SetSearchParamsOptions,
) => void;

function toURLSearchParams(
  value: URLSearchParams | string | Record<string, unknown>,
): URLSearchParams {
  if (value instanceof URLSearchParams) return value;
  if (typeof value === 'string') return new URLSearchParams(value);
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    params.set(key, String(raw));
  }
  return params;
}

function searchParamsToObject(params: URLSearchParams): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [key, val] of params.entries()) obj[key] = val;
  return obj;
}

/**
 * Drop-in replacement for react-router v6's `useSearchParams`. Returns a
 * `[URLSearchParams, setSearchParams]` tuple. `setSearchParams` accepts the
 * same shapes react-router supports (object, string, `URLSearchParams`, or an
 * updater function) plus `{ replace }`.
 */
export function useSearchParams(): [URLSearchParams, SetSearchParams] {
  // `strict: false` lets this read search from whatever route is active,
  // without each route needing a typed search schema.
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const location = useLocation();

  // Build a URLSearchParams from the active route's parsed search. Use the
  // raw search string when available so values round-trip identically to
  // react-router (e.g. encoded chars), falling back to the parsed object.
  const params = useMemo(() => {
    const raw = location.searchStr ?? '';
    if (raw.length > 0) return new URLSearchParams(raw);
    return toURLSearchParams(search as Record<string, unknown>);
  }, [location.searchStr, search]);

  const setSearchParams = useCallback<SetSearchParams>(
    (next, options) => {
      const current = new URLSearchParams(location.searchStr ?? '');
      const resolved = typeof next === 'function' ? next(current) : next;
      const nextParams = toURLSearchParams(resolved);
      // Omitting `to` keeps us on the current route and only swaps search,
      // matching react-router's setSearchParams. `search` fully replaces the
      // current search object (react-router semantics), so we pass the
      // complete next param set. This shim is route-agnostic by design, so we
      // cast past TanStack's per-route typed-search reducer signature.
      void navigate({
        search: searchParamsToObject(nextParams),
        replace: options?.replace ?? false,
      } as unknown as Parameters<typeof navigate>[0]);
    },
    [navigate, location.searchStr],
  );

  return [params, setSearchParams];
}
