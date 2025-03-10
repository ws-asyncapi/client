export function joinUrlPath(baseUrl: string, path: string): string {
    const urlEndsWithSlash = baseUrl.endsWith("/");
    const pathStartsWithSlash = path.startsWith("/");

    if (urlEndsWithSlash && pathStartsWithSlash) {
        return baseUrl + path.slice(1);
    }

    if (!urlEndsWithSlash && !pathStartsWithSlash) {
        return `${baseUrl}/${path}`;
    }

    return baseUrl + path;
}
