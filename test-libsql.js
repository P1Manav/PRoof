import { createClient } from "@libsql/client";
try {
  const libsql = createClient({ url: "file:./dev.db" });
  console.log("Success with file:./dev.db");
} catch (err) {
  console.error("Error with file:./dev.db", err);
}
try {
  const libsql = createClient({ url: process.env.DATABASE_URL || "file:dev.db" });
  console.log("Success with DATABASE_URL or file:dev.db");
} catch (err) {
  console.error("Error with DATABASE_URL or file:dev.db", err);
}
