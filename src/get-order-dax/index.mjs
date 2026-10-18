// --- Module-scope initialization (runs once per cold start, reused warm) ---
// Reads go through DAX. amazon-dax-client presents a DynamoDB-compatible
// DocumentClient-style interface. DAX is only reachable from inside the VPC,
// which is why this function is VPC-attached.
import AmazonDaxClient from "amazon-dax-client";
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.ORDERS_TABLE_NAME;
const DAX_ENDPOINT = process.env.DAX_ENDPOINT;

// Build the DAX-backed document client once. If DAX_ENDPOINT is missing we
// fall back to DynamoDB directly so the function still works outside a DAX
// environment (e.g. local testing).
let docClient;

function getClient() {
  if (docClient) return docClient;

  if (DAX_ENDPOINT) {
    const dax = new AmazonDaxClient({
      endpoints: [DAX_ENDPOINT],
      region: process.env.AWS_REGION,
    });
    // amazon-dax-client is compatible with the v2-style DocumentClient API.
    docClient = dax;
  } else {
    docClient = DynamoDBDocument.from(new DynamoDB({}));
  }
  return docClient;
}

/**
 * Reads all items for an order via DAX.
 * Expects an API Gateway proxy event with pathParameters.orderId.
 */
export const handler = async (event) => {
  try {
    const orderId = event?.pathParameters?.orderId;
    if (!orderId) {
      return respond(400, { message: "orderId path parameter is required." });
    }

    const client = getClient();

    // Query the partition key via DAX. The amazon-dax-client exposes a
    // promise-returning query() compatible with the DocumentClient contract.
    const result = await client
      .query({
        TableName: TABLE_NAME,
        KeyConditionExpression: "orderId = :orderId",
        ExpressionAttributeValues: { ":orderId": orderId },
      })
      .promise();

    return respond(200, {
      orderId,
      count: result.Count ?? 0,
      items: result.Items ?? [],
      source: DAX_ENDPOINT ? "dax" : "dynamodb",
    });
  } catch (err) {
    console.error("Failed to read order via DAX:", err);
    return respond(500, { message: "Failed to retrieve order." });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
