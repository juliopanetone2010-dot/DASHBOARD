
import { handler } from "./index.ts";

const req = new Request("http://localhost:8080", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userId: "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9",
    siteId: "28404d69-ba48-432c-ae7c-2610f79ab81f",
    range: "TODAY",
    forceRefresh: true
  }),
});

async function run() {
  console.log("Starting debug sync...");
  const result = await handler(req);
  const body = await result.json();
  
  const auditId = "23207554976";
  const logs = body.debug || [];
  const found = logs.filter((l: string) => l.includes(auditId));
  
  if (found.length > 0) {
    console.log(`FOUND ${auditId} in logs:`);
    found.forEach((l: string) => console.log(l));
  } else {
    console.log(`NOT FOUND ${auditId} in logs.`);
    console.log("Sample logs containing 'raw=':");
    logs.filter((l: string) => l.includes("raw=")).slice(0, 10).forEach((l: string) => console.log(l));
    
    console.log("Sample logs containing 'rows=':");
    logs.filter((l: string) => l.includes("rows=")).slice(0, 10).forEach((l: string) => console.log(l));
  }
}

run().catch(console.error);
