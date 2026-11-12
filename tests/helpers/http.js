/** Base URL of the in-process test server (set by bin/test.js). */
export function baseUrl() {
  return process.env.TEST_BASE_URL;
}

/**
 * A tiny browser stand-in: fetch with a cookie jar and manual redirects, so tests can follow the
 * session and flash cookies exactly as a browser would.
 */
export class TestSession {
  #cookies = new Map();

  #cookieHeader() {
    return [...this.#cookies]
      .map(([name, value]) => {
        return `${name}=${value}`;
      })
      .join("; ");
  }

  #store(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => {
        return part.trim();
      });
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attributes.some((attribute) => {
        return /^max-age=0$/i.test(attribute) || /^expires=.*1970/i.test(attribute);
      });

      if (expired || value === "") {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
  }

  /** Cookie value by name, or undefined. */
  cookie(name) {
    return this.#cookies.get(name);
  }

  async request(method, path, { json, form, body, headers = {} } = {}) {
    const init = { method, redirect: "manual", headers: { ...headers } };

    if (json !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (form !== undefined) {
      init.headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      init.body = body;
    }

    const cookieHeader = this.#cookieHeader();

    if (cookieHeader !== "") {
      init.headers.cookie = cookieHeader;
    }

    const response = await fetch(`${baseUrl()}${path}`, init);
    this.#store(response);
    const text = await response.text();

    return {
      status: response.status,
      headers: response.headers,
      location: response.headers.get("location"),
      text,
      json() {
        return JSON.parse(text);
      },
    };
  }

  get(path, options) {
    return this.request("GET", path, options);
  }

  post(path, options) {
    return this.request("POST", path, options);
  }
}
