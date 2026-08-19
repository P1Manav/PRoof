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

  const prNumber = 9;
  const fullName = 'P1Manav/portfolio';
  const owner = 'P1Manav';
  const repo = 'portfolio';

  const receipts = await prisma.receipt.findMany({
    where: { prNumber, repoFullName: fullName },
    orderBy: { confidence: "desc" },
    include: { user: true },
  });

  if (receipts.length > 0) {
    const topReceipt = receipts[0];
    if (topReceipt.confidence >= 7) {
      const roastBody = `### 🚨 PRoof CI Failure Follow-up\n\n@${topReceipt.user.login} logged **${topReceipt.confidence}/10 confidence** on this code, but CI just failed (\`Intentional CI Failure\`)! 🚨\n\n> *Confidence is quiet, but CI failures are loud.*`;
      
      console.log('Posting CI fail comment to GitHub...');
      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: roastBody,
      });
      console.log('Comment posted:', response.data.html_url);
    }
  } else {
    console.log("No receipt found for PR", prNumber);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
