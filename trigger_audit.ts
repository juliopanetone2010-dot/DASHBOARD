async function main() {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const siteId = "7185031b-788f-4134-b040-0255c4d6f461";

  try {
    const res = await fetch(supabaseUrl + "/functions/v1/gam-sync-revenue", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + supabaseServiceKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mode: "audit_gam",
        site_id: siteId,
        sync: true
      })
    });

    const result = await res.json();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e);
  }
}

main();
