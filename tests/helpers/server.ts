import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

type FixtureServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

export async function startFixtureServer(fixtureDir: string): Promise<FixtureServer> {
  const server: Server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    if (pathname === "/slow.html") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`
          <!doctype html>
          <html lang="en">
            <head>
              <meta charset="utf-8" />
              <title>Slow Detail</title>
              <link rel="stylesheet" href="/styles.css" />
            </head>
            <body>
              <main class="container section">
                <h1>Slow detail page</h1>
                <p>This route intentionally waits before responding.</p>
              </main>
            </body>
          </html>
        `);
      }, 500);
      return;
    }

    if (pathname === "/broken.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(":root { --broken: ; } .about-card { color: #123456; ");
      return;
    }

    const resolvedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.join(fixtureDir, resolvedPath);

    try {
      const fileContents = await readFile(filePath, "utf8");
      response.writeHead(200, { "content-type": contentTypeFor(filePath) });
      response.end(fileContents);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start fixture server.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
