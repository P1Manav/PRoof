import { PrismaClient } from '@prisma/client';
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "pg";
const { Pool } = pkg;
import { App } from 'octokit';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const appId = "4617075";
  const privateKey = fs.readFileSync('c:\\Users\\Maxpr\\Downloads\\pr-o0of.2026-08-17.private-key.pem', 'utf8');
  const installationId = 154388433;

  const app = new App({ appId, privateKey });
  const octokit = await app.getInstallationOctokit(installationId);

  // Inject a mock receipt for PR #9
  const prNumber = 9;
  const fullName = 'P1Manav/portfolio';
  const owner = 'P1Manav';
  const repo = 'portfolio';
  const commenterLogin = 'P1Manav';

  await prisma.user.upsert({
    where: { id: commenterLogin },
    update: {},
    create: { id: commenterLogin, login: commenterLogin },
  });

  await prisma.receipt.upsert({
    where: { repoFullName_prNumber_userId: { repoFullName: fullName, prNumber, userId: commenterLogin } },
    update: { confidence: 10, source: 'comment', commenter: commenterLogin },
    create: { sha: 'mock-sha-9', prNumber, repoFullName: fullName, confidence: 10, source: 'comment', commenter: commenterLogin, userId: commenterLogin },
  });

  console.log(`Mock receipt injected for PR #${prNumber}. Wait for GitHub Action to fail and trigger the webhook naturally!`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
