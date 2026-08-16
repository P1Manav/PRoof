import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import crypto from "crypto";
import "dotenv/config";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database with demo data...");

  // Clean existing
  await prisma.receipt.deleteMany();
  await prisma.user.deleteMany();

  // Create Users
  const users = [
    {
      id: "P1Manav",
      login: "P1Manav",
      avatarUrl: "https://github.com/P1Manav.png",
      totalConfidence: 85,
      successfulPrs: 10,
      failedPrs: 1,
    },
    {
      id: "10xDev",
      login: "10xDev",
      avatarUrl: "https://github.com/github.png",
      totalConfidence: 42,
      successfulPrs: 5,
      failedPrs: 3,
    },
    {
      id: "CodeNinja",
      login: "CodeNinja",
      avatarUrl: "https://github.com/microsoft.png",
      totalConfidence: 95,
      successfulPrs: 12,
      failedPrs: 0,
    }
  ];

  for (const u of users) {
    await prisma.user.create({ data: u });
  }

  // Fetch created users to get their IDs
  const dbUsers = await prisma.user.findMany();
  const manav = dbUsers.find(u => u.login === "P1Manav");
  const dev10x = dbUsers.find(u => u.login === "10xDev");
  const ninja = dbUsers.find(u => u.login === "CodeNinja");

  // Create Receipts
  const receipts = [
    {
      sha: crypto.randomBytes(20).toString('hex'),
      prNumber: 42,
      repoFullName: "P1Manav/PRoof",
      confidence: 10,
      outcome: "SUCCESS",
      userId: manav.id,
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
    },
    {
      sha: crypto.randomBytes(20).toString('hex'),
      prNumber: 43,
      repoFullName: "P1Manav/PRoof",
      confidence: 8,
      outcome: "SUCCESS",
      userId: ninja.id,
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 5), // 5 hours ago
    },
    {
      sha: crypto.randomBytes(20).toString('hex'),
      prNumber: 44,
      repoFullName: "P1Manav/PRoof",
      confidence: 9,
      outcome: "FAILURE",
      userId: dev10x.id,
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24), // 1 day ago
    },
    {
      sha: crypto.randomBytes(20).toString('hex'),
      prNumber: 45,
      repoFullName: "P1Manav/PRoof",
      confidence: 7,
      outcome: "PENDING",
      userId: manav.id,
      timestamp: new Date(Date.now() - 1000 * 60 * 30), // 30 mins ago
    }
  ];

  for (const r of receipts) {
    await prisma.receipt.create({ data: r });
  }

  console.log("Database seeded successfully!");
}

main().catch(console.error).finally(() => prisma.$disconnect());
