# Orders Serverless Application

A serverless "Orders" application built with the **AWS Serverless Application Model (SAM)**. It stores orders in DynamoDB, exposes a REST API through API Gateway, secures it with Cognito, protects it with WAF, and is observable through CloudWatch and X-Ray. The DynamoDB table is a multi-region **global table** for disaster recovery.

This Readme is written as a **step-by-step guide**. Follow it top to bottom to understand what each piece does, how it fits together, and how to deploy and test it.

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [Architecture](#2-architecture)
3. [Project layout](#3-project-layout)
4. [The two templates (important)](#4-the-two-templates-important)
5. [Prerequisites](#5-prerequisites)
6. [Windows + Norton SSL note (read if deploy fails on certificates)](#6-windows--norton-ssl-note)
7. [Step-by-step: build and deploy](#7-step-by-step-build-and-deploy)
8. [Step-by-step: test the API end to end](#8-step-by-step-test-the-api-end-to-end)
9. [Verifying the global table](#9-verifying-the-global-table)
10. [CI/CD with GitHub Actions](#10-cicd-with-github-actions)
11. [Cleanup](#11-cleanup)
12. [Known caveats](#12-known-caveats)

---

## 1. What you get

| Capability | Resource |
|---|---|
| Order storage | DynamoDB **global table** `Orders` (PK `orderId`, SK `itemId`, on-demand) |
| Multi-region DR | Replicas in `us-east-1` (primary) and `us-west-2` (secondary) + DynamoDB Streams |
| Write API | `POST /orders` → Lambda (`SaveOrder`) → DynamoDB |
| Read API | `GET /orders/{orderId}` → **direct** API Gateway → DynamoDB integration (no Lambda) |
| Auth | Amazon Cognito User Pool authorizer on all routes |
| Protection | AWS WAF rate-based rule (1000 req / 5 min per IP) |
| Performance | API Gateway stage caching (TTL 300s) |
| Observability | CloudWatch dashboard + X-Ray tracing |
| Optional acceleration | DAX cluster + VPC + DAX-backed read Lambda (in `template.yaml` only, not deployed by default) |

---

## 2. Architecture

```
          ┌─────────────┐
 Client ──▶  Cognito    │  (obtain IdToken)
          └──────┬──────┘
                 │ Authorization: <IdToken>
                 ▼
          ┌─────────────┐     WAF rate limit + stage cache (TTL 300s)
          │ API Gateway │◀───────────────────────────────────────────
          └──┬───────┬──┘
   POST /orders     GET /orders/{orderId}
             │               │
             ▼               ▼ (direct AWS service integration, no Lambda)
      ┌────────────┐   ┌──────────────┐
      │ SaveOrder  │   │  DynamoDB     │
      │  Lambda    │──▶│  Orders       │  global table
      └────────────┘   │  us-east-1 ◀──┼──▶ us-west-2 replica
                       └──────────────┘
```

- **Writes** go through a Lambda so validation and timestamps can be applied.
- **Reads** use a direct API Gateway → DynamoDB integration (VTL mapping templates), which removes the Lambda from the read path entirely.

---

## 3. Project layout

```
serverless-application/
├─ template.yaml               # Full template: global table + API + Cognito + WAF
│                              # + dashboard + DAX/VPC (DAX NOT deployed by default)
├─ template-globaltable.yaml   # Deployed template: same as above WITHOUT DAX/VPC
├─ samconfig.toml              # SAM deploy defaults (generated)
├─ src/
│  ├─ save-order/
│  │  └─ index.mjs             # POST /orders handler (writes to DynamoDB)
│  └─ get-order-dax/
│     ├─ index.mjs             # DAX-backed read handler (only used by template.yaml)
│     └─ package.json          # declares amazon-dax-client
├─ .github/workflows/
│  └─ deploy.yml               # CI: build + deploy on push to main
├─ .gitignore
└─ README.md
```

---

## 4. The two templates (important)

There are **two** SAM templates. Pick the right one:

- **`template-globaltable.yaml`** — this is what is **currently deployed**. It has everything except DAX/VPC. Use this for normal deploys. It avoids the ongoing cost of a DAX cluster.
- **`template.yaml`** — the full reference template. It additionally contains the DAX cluster, a VPC, and a DAX-backed read Lambda (`GET /dax-orders/{orderId}`). Deploying this provisions a VPC and a DAX node (extra cost + ~10 min create). Only use it if you specifically want DAX.

> If you only want the multi-region Orders API, use `template-globaltable.yaml`.

---

## 5. Prerequisites

- **AWS account** and credentials configured (`aws configure`).
- **AWS SAM CLI** — [install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).
- **AWS CLI v2**.
- **Node.js 20+** and **Python 3.12+** (SAM CLI needs Python).
- IAM permissions to create: CloudFormation, DynamoDB, Lambda, API Gateway, Cognito, WAFv2, CloudWatch, IAM roles, S3.

Verify:

```powershell
sam --version
aws --version
```

---

## 6. Windows + Norton SSL note

If `sam deploy` or `npm install` fails with `CERTIFICATE_VERIFY_FAILED` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, your machine has **Norton (or similar) HTTPS/SSL scanning** that intercepts TLS and presents its own certificate. The SAM CLI and npm validate against their own CA bundle, which does not trust Norton's root.

**Fix** — build a combined CA bundle (public roots + Norton's root) and point the tools at it:

```powershell
# 1. Export Norton's root CA + append to the certifi bundle (one-time)
#    (adjust the certifi path to your Python install)
$certifi = "C:\Users\<you>\AppData\Local\Programs\Python\Python3xx\Lib\site-packages\certifi\cacert.pem"
$bundle  = "C:\Users\<you>\aws-ca-bundle.pem"
Copy-Item $certifi $bundle -Force
# export the Norton root from the Windows cert store and append it to $bundle ...

# 2. Point SAM / AWS CLI at it
$env:AWS_CA_BUNDLE = "C:\Users\<you>\aws-ca-bundle.pem"

# 3. Point npm at it (only needed when a function has dependencies)
npm config set cafile "C:\Users\<you>\aws-ca-bundle.pem"
```

The cleaner long-term fix is to disable SSL scanning (or exclude `*.amazonaws.com` and `registry.npmjs.org`) in Norton. GitHub Actions runners do **not** have this problem, so CI needs none of this.

---

## 7. Step-by-step: build and deploy

### Step 1 — build

`sam build` packages the Lambda code. Always run it before deploy; `sam deploy` does **not** auto-rebuild.

```powershell
sam build --template-file template-globaltable.yaml
```

### Step 2 — deploy

First time, use guided mode to save defaults:

```powershell
sam deploy --guided --template-file template-globaltable.yaml
```

Answer the prompts:

| Prompt | Value |
|---|---|
| Stack Name | `serverless-application` |
| AWS Region | `us-east-1` |
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | `Y` |
| `SaveOrderFunction has no authentication` | `y` (expected — auth is at the authorizer) |
| SAM configuration file | *(press Enter — do not type `y`)* |

After the first run, subsequent deploys are just:

```powershell
sam build --template-file template-globaltable.yaml
sam deploy
```

### Step 3 — note the outputs

The deploy prints outputs. Save these:

- `CreateOrderApiUrl` — POST endpoint
- `GetOrderApiUrl` — GET endpoint template
- `UserPoolId`, `UserPoolClientId` — needed to get tokens
- `OrdersTableStreamArn`, `OrdersTableSecondaryRegion` — global table info

---

## 8. Step-by-step: test the API end to end

The API is protected by Cognito, so you need a user and a token.

### Step 1 — create a test user

```powershell
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> `
  --username "testuser@example.com" --message-action SUPPRESS --region us-east-1

aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> `
  --username "testuser@example.com" --password "TestPass123" --permanent --region us-east-1
```

### Step 2 — get an ID token

```powershell
aws cognito-idp initiate-auth --client-id <UserPoolClientId> `
  --auth-flow USER_PASSWORD_AUTH `
  --auth-parameters USERNAME=testuser@example.com,PASSWORD=TestPass123 `
  --region us-east-1
```

Copy the `IdToken` from `AuthenticationResult`.

### Step 3 — create an order (POST)

```powershell
curl -X POST "<CreateOrderApiUrl>" `
  -H "Authorization: <IdToken>" -H "Content-Type: application/json" `
  -d '{"orderId":"o-1001","itemId":"i-01","quantity":2,"product":"Widget"}'
```

Expected: `201` with `{"message":"Order saved.", ...}`. A missing `orderId`/`itemId` returns `400`.

### Step 4 — read the order back (GET, no Lambda)

```powershell
curl "<GetOrderApiUrl replacing {orderId} with o-1001>" -H "Authorization: <IdToken>"
```

Expected: `200` with `{ "orderId": "o-1001", "count": 1, "items": [ ... ] }`.

> Requests without a valid token return **401**. An expired token can surface as **403**.

---

## 9. Verifying the global table

Confirm streams are on and both replicas exist:

```powershell
# Primary region view
aws dynamodb describe-table --table-name Orders --region us-east-1 `
  --query "Table.{Stream:StreamSpecification,Replicas:Replicas[].RegionName}"

# Secondary region view (should be ACTIVE)
aws dynamodb describe-table --table-name Orders --region us-west-2 `
  --query "Table.TableStatus"
```

Test replication — write to one region, read from the other:

```powershell
aws dynamodb put-item --table-name Orders --region us-east-1 `
  --item '{\"orderId\":{\"S\":\"gt-test\"},\"itemId\":{\"S\":\"i-1\"}}'

aws dynamodb get-item --table-name Orders --region us-west-2 `
  --key '{\"orderId\":{\"S\":\"gt-test\"},\"itemId\":{\"S\":\"i-1\"}}'
```

The item should appear in `us-west-2` within a few seconds.

---

## 10. CI/CD with GitHub Actions

`.github/workflows/deploy.yml` builds and deploys on every push to `main`.

**Setup:**

1. Add two repository secrets (Settings → Secrets and variables → Actions):
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
2. Push to `main`:

```powershell
git add .
git commit -m "Deploy orders app"
git push
```

The workflow runs `sam validate`, `sam build`, then `sam deploy` against `serverless-application` in `us-east-1`. (It uses the default template; point it at `template-globaltable.yaml` if you want the DAX-free version in CI.)

> For stronger security, consider switching from stored access keys to GitHub OIDC with an assumed IAM role.

---

## 11. Cleanup

Delete the whole stack (removes the table and all data):

```powershell
aws cloudformation delete-stack --stack-name serverless-application --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name serverless-application --region us-east-1
```

> The global table replica in `us-west-2` is removed as part of the stack deletion.

---

## 12. Known caveats

- **Two templates:** `template-globaltable.yaml` is deployed; `template.yaml` adds DAX/VPC (extra cost, not deployed by default).
- **DAX requires a VPC** and is only reachable from in-VPC compute — it cannot be used by the direct API Gateway → DynamoDB read integration.
- **`amazon-dax-client`** is a dependency (not in the Lambda runtime), so the DAX function needs `npm install` during build — which triggers the SSL note above on affected machines.
- **Global table conversion is destructive in place:** `AWS::DynamoDB::GlobalTable` is a different resource type from `AWS::DynamoDB::Table`. Converting an existing table required recreating the stack. Plan a migration (export/restore or `update-table` add-replica) if you have production data.
- **Recreating the stack changes IDs:** API ID, Cognito pool, and client IDs change on a fresh deploy, and the Cognito user pool starts empty.
- **`sam deploy` uses the last build:** always `sam build` after changing the template or code, or it may report "No changes to deploy".
- **Public endpoints:** the API is authenticated but internet-facing. Add tighter auth/throttling before production use.
