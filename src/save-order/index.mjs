// --- Module-scope initialization (runs once per cold start, reused warm) ---
// Import only the specific clients/commands needed to keep the module graph
// minimal. On the nodejs managed runtime the AWS SDK v3 is provided by Lambda,
// so it is NOT bundled into the deployment package.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

// Reuse TCP connections across invocations for lower per-call latency.
// (Also controllable via the AWS_NODEJS_CONNECTION_REUSE_ENABLED env var.)
const client = new DynamoDBClient({
  maxAttempts: 3,
});

// Marshalling options defined once at init, not per request.
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
});

const TABLE_NAME = process.env.ORDERS_TABLE_NAME;

/**
 * Saves an order item to the Orders DynamoDB table.
 *
 * Accepts either a direct Lambda invocation payload or an API Gateway
 * proxy event (where the order is in the JSON `body`).
 *
 * Expected order shape (orderId and itemId are required):
 *   { "orderId": "...", "itemId": "...", ...any other attributes }
 */
export const handler = async (event) => {
  try {
    const order = parseOrder(event);

    if (!order.orderId || !order.itemId) {
      return respond(400, {
        message: "Both 'orderId' and 'itemId' are required.",
      });
    }

    const item = {
      ...order,
      createdAt: order.createdAt ?? new Date().toISOString(),
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );

    return respond(201, {
      message: "Order saved.",
      order: { orderId: item.orderId, itemId: item.itemId },
    });
  } catch (err) {
    console.error("Failed to save order:", err);
    return respond(500, { message: "Failed to save order." });
  }
};

function parseOrder(event) {
  if (event && typeof event.body === "string") {
    return JSON.parse(event.body);
  }
  if (event && typeof event.body === "object" && event.body !== null) {
    return event.body;
  }
  return event ?? {};
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
