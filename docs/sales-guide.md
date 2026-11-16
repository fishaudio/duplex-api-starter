# Fish Audio Realtime Voice Agent

Fish Audio Realtime lets people talk with a voice agent, interrupt it, and continue the conversation while the agent takes actions through tools. This starter demonstrates that experience in a browser, with a live order screen and an event inspector that shows what happened.

The example is a fictional neighborhood diner: a guest asks about the menu, orders a burger and fries, changes an item, and confirms the order. The same application structure can be adapted to other conversational workflows by replacing the scenario, business data, and tools.

**Release note:** This guide is being shared ahead of the refreshed demo code. The script below uses generic menu names; run it with the presenter-provided demo build. The repository's default branch may still show an earlier interface or menu.

## What to show

| Demo moment | What the audience sees |
| --- | --- |
| Speak naturally | The guest talks through a browser microphone, and the agent responds with streamed speech. |
| Ask a menu question | The agent looks up menu information through a tool instead of treating every utterance as an order. |
| Place or change an order | Tool calls update the visible order, quantities, modifiers, and total. |
| Interrupt a reply | The guest can speak while the agent is talking and redirect the conversation. |
| Pause and continue a thought | Eager turn handling begins preparing a reply during a pause; order-changing tools wait for the caller's turn to be committed. |
| Inspect the interaction | The event panel shows turn events, model activity, tool execution, and reply progress. |

The displayed order is demo application state. It is not connected to a restaurant's production ordering, inventory, or payment system.

## A short live demo

Use a quiet room and a headset for the first demonstration. Test the selected microphone and speaker before the call. Keep the order screen visible; open the event inspector when explaining how actions happen.

1. **Start a call.** Let the greeting finish, then ask, “What burgers do you have?” Point out the menu lookup and the spoken response.
2. **Place an order.** Say, “One burger meal with a cola, no pickles.” Show the order line and its modifiers. Answer any follow-up question about a missing detail.
3. **Change your mind.** Say, “Actually, keep the pickles.” Show the change on the existing item rather than a second order line.
4. **Interrupt naturally.** While the agent is speaking, say, “And add small fries.” Let the agent respond and inspect the order. Avoid reading a rigid script over the agent; the point is to show a normal correction or addition.
5. **Finish.** Say, “That's all.” Review the read-back and total, then confirm. The agent should finish its farewell before the call closes.

Menu prices are illustrative. Verify the selected build's menu before presenting; describe what the live demonstration actually shows.

## Suggested introduction

> “This is a voice agent built with Fish Audio Realtime. You can speak naturally, interrupt it, and ask it to change an order. The screen shows the actions it takes, so you can see the connection between the conversation and the application. This diner is one example; a developer can replace the menu and order tools with their own workflow.”

## How it works

The browser captures microphone audio and plays the agent's response. A TypeScript Node.js server connects to Fish Audio Realtime at `wss://api.fish.audio/v1/realtime/converse`. Gemini on Vertex AI generates responses and chooses application tools; the server executes those tools and updates the order screen.

The current demo configuration uses **Gemini 3.8 Flash** with the **Vertex AI Priority** tier. These are application choices, not requirements for every Fish Audio integration. The UI also allows model and tier selection.

The starter includes:

- A React browser interface with microphone and speaker selection.
- Streamed audio, eager turn handling, interruption handling, and a playback buffer.
- Read-only menu/order tools and separate tools for order changes and confirmation.
- Optional kitchen ambience mixed on the server and reduced while the agent speaks.
- Browser echo-cancellation support and a live event inspector.

The application is TypeScript across the browser and server. The example uses a WebSocket connection; adding phone, contact-center, or other channels requires the corresponding integration.

## Adapting it to a customer workflow

| Starting point | What a developer replaces or adds |
| --- | --- |
| Another ordering experience | Catalog, prices, modifiers, availability rules, and ordering-system integration. |
| Booking or scheduling | Availability lookup, booking tools, confirmation rules, and calendar or reservation integration. |
| Customer support | Approved knowledge sources, account lookup, escalation paths, and support-system integration. |
| Other spoken transactions | Business tools, authorization rules, confirmation steps, and application state. |

These are adaptation paths, not integrations included in the starter. The distinction between reading data and changing data is useful across these workflows: a speculative reply should not create a booking or change an order before the caller's turn is accepted.

## Questions to answer accurately

**Is this ready to deploy as a production ordering system?**  
It is a reference application for evaluation and development. A deployment still needs the customer's real systems, access controls, operational monitoring, failure handling, and workflow-specific testing.

**What latency should we quote?**  
Do not quote a fixed end-to-end latency from this guide. The experience depends on the model, network, devices, turn timing, synthesis, and playback. A model time-to-first-token reading is not the same as the time until the guest hears the response.

**Does speakerphone use work without echo?**  
The browser requests echo cancellation and routes playback to support it. Performance depends on the browser, operating system, microphone, and speaker setup. Validate the actual presentation hardware; do not describe this as independently verified echo removal on every device.

**Does a confirmed demo order charge a customer?**  
No. Confirmation changes the demo order state. Production payment and fulfillment integrations are not included.

**What is needed to run it?**  
An engineer configures Node.js, Fish Audio Realtime credentials, and Vertex AI credentials, then starts the application. Use the repository's setup instructions for the matching code version. Credentials belong on the server and should never appear in a screen share, customer handout, or recording.

**What can sales share now?**  
This guide and a demonstration of a verified build. The repository is private, so a GitHub link requires repository access. Availability, pricing, service commitments, and deployment scope should be confirmed for the customer's project separately.
