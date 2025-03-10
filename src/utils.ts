export function joinUrlPath(
    baseUrl: string,
    path: string,
    query?: Record<string, string>,
): string {
    const urlEndsWithSlash = baseUrl.endsWith("/");
    const pathStartsWithSlash = path.startsWith("/");

    const queryString = query
        ? `?${new URLSearchParams(query).toString()}`
        : "";

    if (urlEndsWithSlash && pathStartsWithSlash) {
        return baseUrl + path.slice(1) + queryString;
    }

    if (!urlEndsWithSlash && !pathStartsWithSlash) {
        return `${baseUrl}/${path}${queryString}`;
    }

    return `${baseUrl}${path}${queryString}`;
}
