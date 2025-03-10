import { expect, test } from "bun:test";
import { joinUrlPath } from "../src/utils.js";

test("joinUrlPath correctly joins URLs", () => {
    expect(joinUrlPath("http://site.com", "api")).toBe("http://site.com/api");
    expect(joinUrlPath("https://cdn.site/", "/v1")).toBe("https://cdn.site/v1");
    expect(joinUrlPath("ws://server", "live/feed")).toBe(
        "ws://server/live/feed",
    );

    expect(joinUrlPath("http://a", "")).toBe("http://a/");
    expect(joinUrlPath("http://a/b", "/c")).toBe("http://a/b/c");
});
