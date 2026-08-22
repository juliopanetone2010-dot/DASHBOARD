import asyncio
import os
import json
import requests
from google.oauth2 import service_account
from google.auth.transport.requests import Request

async def check_data_transfer(network_code):
    sa_json = os.environ.get("GAM_SERVICE_ACCOUNT_JSON")
    if not sa_json:
        print("GAM_SERVICE_ACCOUNT_JSON not found")
        return

    sa_info = json.loads(sa_json)
    scopes = ["https://www.googleapis.com/auth/admanager"]
    creds = service_account.Credentials.from_service_account_info(sa_info, scopes=scopes)
    creds.refresh(Request())
    
    token = creds.token
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    # 1. Check Network Info
    url = f"https://admanager.googleapis.com/v1/networks/{network_code}"
    res = requests.get(url, headers=headers)
    print(f"Network Info ({res.status_code}):")
    print(json.dumps(res.json(), indent=2))

    # 2. Try to list Data Transfer reports if possible (REST API doesn't have it yet, usually SOAP)
    # But we can look at the features list in the network response if it exists.

if __name__ == "__main__":
    asyncio.run(check_data_transfer("21689438096"))
