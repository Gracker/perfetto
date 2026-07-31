// Copyright (C) 2024 SmartPerfetto
//
// Shared browser transport policy for SmartPerfetto backend requests.

/**
 * SmartPerfetto's OIDC session is a HttpOnly cookie. The committed frontend
 * and backend use different ports in source/Docker paths, so browser fetch()
 * must opt into credentials even though both services are same-site.
 */
export function fetchSmartPerfettoBackend(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, {
    ...init,
    credentials: init.credentials ?? 'include',
  });
}
