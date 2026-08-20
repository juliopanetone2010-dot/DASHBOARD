import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const customerIds = [
    '6367765082', '7985870941', '7159182376', '5944110397', '8447348298', 
    '1711397823', '9193017572', '9530415545', '9664576382', '7733230833', 
    '8443202296', '7484181468', '2015278850', '1857979447', '2756256954', 
    '6121290046', '6966888166', '5828420756', '3453985229', '6042097101', 
    '7722253229', '8652215298', '6537143141', '9587050711', '3313808829'
  ];

  const { data, error } = await supabase
    .from("google_accounts")
    .update({ status: "suspended" })
    .in("customer_id", customerIds);

  if (error) {
    console.error("Error updating accounts:", error);
  } else {
    console.log(`Successfully updated ${customerIds.length} accounts to suspended status.`);
  }
}

run();
