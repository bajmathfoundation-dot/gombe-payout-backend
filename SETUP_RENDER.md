# Render Deployment Guide

## Prerequisites

- [ ] GitHub account (free)
- [ ] Render account (free — sign up with GitHub)
- [ ] Paystack secret key
- [ ] Firebase service account JSON

## Step 1: Get Firebase Service Account

1. Firebase Console → Your project
2. ⚙️ Project Settings → Service Accounts tab
3. Click **Generate New Private Key**
4. Download the JSON file (keep it secret!)
5. Open the JSON — you'll need its contents

The JSON looks like:
```json
{
  "type": "service_account",
  "project_id": "gombefootball",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-xxx@gombefootball.iam.gserviceaccount.com",
  ...
}