# Hermes Agent Bridge Setup

## Purpose

BuildTrack AI Agent Bridge lets approved Hermes agents, such as Benito, create Scope of Work and Punch List records in the existing BuildTrack database from Telegram text or voice commands.

Architecture:

Telegram -> Hermes/Benito -> secure BuildTrack API -> BuildTrack backend/database -> desktop/mobile UI

Agents must not write directly to the desktop app. The normal BuildTrack UI reads the new records from the backend.

## Create an Agent API Key

1. Sign in to BuildTrack as a Super Admin or Operations Manager.
2. Open Settings -> AI Agent Bridge.
3. Create an agent, for example `Benito`.
4. Grant only the scopes the agent needs:
   - `property:read`
   - `scope_of_work:write`
   - `punch_list:write`
5. Click Generate API Key.
6. Copy the key immediately. BuildTrack stores only the hashed key and will not show the raw key again.
7. Store the key in Hermes secrets as `BUILDTRACK_AGENT_API_KEY` or an equivalent secure secret.

## Required Headers

Every agent request must include:

```http
Authorization: Bearer AGENT_API_KEY
X-BuildTrack-Agent-Name: Benito
X-Request-Id: unique-telegram-message-id
Content-Type: application/json
```

`X-BuildTrack-Agent-Key: AGENT_API_KEY` can be used instead of the Authorization bearer header.

Use the Telegram message ID, voice transcription ID, or Hermes tool call ID as `X-Request-Id`. BuildTrack rejects duplicate request IDs so retries do not duplicate scope or punch items.

## Scope Of Work Request

```bash
curl -X POST https://buildtrack.newurbandev.com/api/agent-bridge/scope-of-work \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "X-BuildTrack-Agent-Name: Benito" \
  -H "X-Request-Id: telegram-message-id" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "telegram-message-id",
    "agentName": "Benito",
    "source": "telegram",
    "intent": "scope_of_work",
    "propertyAddress": "123 Main Street, Detroit, MI",
    "rawTranscript": "Scope of work for 123 Main Street: demo kitchen cabinets, replace drywall in living room, install new vinyl flooring, paint all bedrooms.",
    "title": "AI Generated Scope of Work",
    "items": [
      {
        "description": "Demo kitchen cabinets",
        "category": "Demolition",
        "location": "Kitchen",
        "priority": "normal",
        "trade": "General Contractor",
        "status": "not_started"
      }
    ]
  }'
```

## Punch List Request

```bash
curl -X POST https://buildtrack.newurbandev.com/api/agent-bridge/punch-list \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "X-BuildTrack-Agent-Name: Benito" \
  -H "X-Request-Id: telegram-message-id" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "telegram-message-id",
    "agentName": "Benito",
    "source": "telegram",
    "intent": "punch_list",
    "propertyAddress": "123 Main Street, Detroit, MI",
    "rawTranscript": "Punch list for 123 Main Street: fix loose handrail, touch up paint in hallway, replace missing outlet cover, clean basement.",
    "title": "AI Generated Punch List",
    "items": [
      {
        "description": "Fix loose handrail",
        "location": "Stairway",
        "priority": "high",
        "trade": "Carpentry",
        "status": "open"
      }
    ]
  }'
```

## Successful Response

```json
{
  "success": true,
  "requestId": "telegram-message-id",
  "property": {
    "propertyId": "project-id",
    "address": "123 Main Street, Detroit, MI",
    "jobName": "123 Main Street"
  },
  "created": {
    "scopeCount": 1,
    "scopeItemCount": 4
  }
}
```

## Failed Property Match

If multiple properties match, BuildTrack returns HTTP 409:

```json
{
  "success": false,
  "error": "AMBIGUOUS_PROPERTY_MATCH",
  "message": "Multiple BuildTrack properties match this address. Please clarify.",
  "matches": [
    {
      "propertyId": "abc123",
      "address": "123 Main Street, Detroit, MI 48201"
    },
    {
      "propertyId": "def456",
      "address": "123 Main Street, Warren, MI 48089"
    }
  ]
}
```

If no property exists, BuildTrack returns HTTP 404 with `PROPERTY_NOT_FOUND`. Hermes should ask the user to clarify or confirm that the property exists in BuildTrack. Do not create a new property from the agent bridge.

## Hermes Instruction Text

When the user says 'scope of work' followed by an address and task details, call BuildTrack Agent Bridge using the scope_of_work endpoint. First identify the property address. Convert the spoken tasks into clean line-by-line construction scope items. Do not invent property addresses. If the property is missing or ambiguous, ask the user to clarify. If the user says 'punch list' followed by an address and task details, call the punch_list endpoint and create clean line-by-line punch-list tasks.

Supported command patterns include:

- Scope of work for 123 Main Street...
- Create a scope for 123 Main...
- New scope of work at 123 Main...
- SOW for 123 Main...
- Punch list for 123 Main...
- Create punch list at 123 Main...
- Add punch items for 123 Main...

## Validation Rules

- Do not send API keys to the browser or Telegram client.
- Do not invent property addresses.
- Send either `propertyId` or `propertyAddress`.
- Send structured `items` whenever possible.
- If only `rawTranscript` is available, BuildTrack will split line items from bullets, numbers, commas, semicolons, and natural task separators.
- BuildTrack rejects disabled agents, invalid keys, missing scopes, missing address, missing items, duplicate request IDs, missing properties, and ambiguous property matches.
