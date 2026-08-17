import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const installs = await prisma.installation.findMany();
  console.log('--- Installations ---');
  console.log(JSON.stringify(installs, null, 2));
  
  const prompts = await prisma.confidencePrompt.findMany({
    where: { repoFullName: { contains: 'portfolio' } }
  });
  console.log('--- Prompts for portfolio ---');
  console.log(JSON.stringify(prompts, (key, value) =>
            typeof value === 'bigint'
                ? value.toString()
                : value
        , 2));

  const receipts = await prisma.receipt.findMany({
    where: { repoFullName: { contains: 'portfolio' } }
  });
  console.log('--- Receipts for portfolio ---');
  console.log(JSON.stringify(receipts, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
