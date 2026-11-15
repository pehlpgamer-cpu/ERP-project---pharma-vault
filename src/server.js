import "dotenv/config";
import { assertConfiguration } from "../app/services/support/configCheck.js";
import app, { bootstrap } from "./app.js";

const PORT = process.env.PORT ?? 3000;
const NODE_ENV = process.env.NODE_ENV ?? "development";

async function startServer() {
  // a mistyped setting is a one-line message, not a stack trace
  try {
    assertConfiguration();
  } catch (error) {
    console.error(`❌ Configuration error: ${error.message}`);
    process.exitCode = 1;

    return;
  }

  await bootstrap();

  app.listen(PORT, () => {
    console.log(`🔥 Pharma Vault running at http://localhost:${PORT}`);

    console.log(`🔥 Environment: ${NODE_ENV}`);
  });
}

startServer().catch((error) => {
  console.error("❌ Failed to start Pharma Vault:", error);

  process.exitCode = 1;
});
