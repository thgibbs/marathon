import { describe, expect, it } from "vitest";
import {
  GITHUB_APP_EVENTS,
  GITHUB_APP_PERMISSIONS,
  buildGithubAppManifest,
  manifestPostUrl,
  registrationPageHtml,
} from "../src/github-manifest.js";

describe("buildGithubAppManifest", () => {
  it("builds a private app manifest with the document-surface permissions and events", () => {
    const m = buildGithubAppManifest({
      name: "marathon-abc123",
      webhookUrl: "https://smee.io/chan",
      redirectUrl: "http://localhost:8895/callback",
    });
    expect(m.name).toBe("marathon-abc123");
    expect(m.public).toBe(false);
    expect(m.hook_attributes.url).toBe("https://smee.io/chan");
    expect(m.redirect_url).toBe("http://localhost:8895/callback");
    expect(m.default_permissions).toEqual(GITHUB_APP_PERMISSIONS);
    expect(m.default_events).toEqual([...GITHUB_APP_EVENTS]);
  });

  it("uses the provided homepage URL when given", () => {
    const m = buildGithubAppManifest({
      name: "x",
      webhookUrl: "https://example.test/hook",
      redirectUrl: "http://localhost:1/callback",
      homepageUrl: "https://example.test/home",
    });
    expect(m.url).toBe("https://example.test/home");
  });
});

describe("manifestPostUrl", () => {
  it("targets the personal account by default", () => {
    expect(manifestPostUrl()).toBe("https://github.com/settings/apps/new");
  });

  it("targets the organization settings page when an org is given", () => {
    expect(manifestPostUrl("my org")).toBe(
      "https://github.com/organizations/my%20org/settings/apps/new",
    );
  });
});

describe("registrationPageHtml", () => {
  it("embeds the manifest JSON (HTML-escaped) in a form posting to GitHub", () => {
    const m = buildGithubAppManifest({
      name: 'quote"name',
      webhookUrl: "https://smee.io/chan",
      redirectUrl: "http://localhost:8895/callback",
    });
    const html = registrationPageHtml(m, manifestPostUrl());
    expect(html).toContain('action="https://github.com/settings/apps/new"');
    expect(html).toContain('name="manifest"');
    // The quote in the app name is JSON-escaped (\") and then HTML-escaped
    // (&quot;) — without the HTML pass it would truncate the hidden input's
    // value attribute.
    expect(html).toContain('quote\\&quot;name');
    expect(html).not.toContain('value="{"');
  });
});
