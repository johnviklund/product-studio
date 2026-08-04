import { writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const scenario = JSON.parse(process.env.PRODUCT_STUDIO_FAKE_ACP_SCENARIO ?? "{}");
const sentinelPath = process.env.PRODUCT_STUDIO_FAKE_ACP_SENTINEL ?? null;
const sessionId = "product-studio-fake-session";
let currentConfigOptions = Array.isArray(scenario.session_config_options)
  ? scenario.session_config_options
  : [];
let clientCapabilities = {};

function permissionOptions() {
  return [
    { kind: "allow_once", name: "Allow once", optionId: "allow" },
    { kind: "reject_once", name: "Reject once", optionId: "reject" },
  ];
}

const application = acp
  .agent({ name: "product-studio-fake-agent" })
  .onRequest(acp.methods.agent.initialize, async (context) => {
    clientCapabilities = context.params.clientCapabilities;
    if (scenario.record_client_capabilities === true && sentinelPath !== null) {
      await writeFile(
        `${sentinelPath}.client-capabilities`,
        `${JSON.stringify(clientCapabilities)}\n`,
        "utf8",
      );
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  })
  .onRequest(acp.methods.agent.session.new, (context) => {
    if (!Array.isArray(context.params.mcpServers) || context.params.mcpServers.length !== 0) {
      throw new Error("The client must request zero MCP servers.");
    }
    if (
      typeof scenario.session_new_notification_delay_ms === "number" &&
      scenario.session_new_notification_delay_ms >= 0
    ) {
      setTimeout(() => {
        void context.client
          .notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [],
            },
          })
          .catch(() => undefined);
      }, scenario.session_new_notification_delay_ms);
    }
    return {
      sessionId,
      ...(currentConfigOptions.length > 0
        ? { configOptions: currentConfigOptions }
        : {}),
    };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, async (context) => {
    if (sentinelPath !== null) {
      await writeFile(
        `${sentinelPath}.set-config-pid`,
        `${process.pid}\n`,
        "utf8",
      );
    }
    if (
      typeof scenario.set_config_option_delay_ms === "number" &&
      scenario.set_config_option_delay_ms > 0
    ) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, scenario.set_config_option_delay_ms),
      );
    }
    currentConfigOptions = Array.isArray(scenario.set_config_option_response)
      ? scenario.set_config_option_response
      : currentConfigOptions.map((option) =>
          option.id === context.params.configId
            ? { ...option, currentValue: context.params.value }
            : option,
        );
    if (sentinelPath !== null) {
      await writeFile(
        `${sentinelPath}.set-config`,
        `${JSON.stringify(context.params)}\n`,
        "utf8",
      );
    }
    if (scenario.notify_set_config_option !== false) {
      const notification = context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: currentConfigOptions,
        },
      });
      if (scenario.ignore_set_config_notification_failure === true) {
        void notification.catch(() => undefined);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      } else {
        await notification;
      }
    }
    return { configOptions: currentConfigOptions };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    if (scenario.kind === "silent_refusal") {
      return { stopReason: "refusal" };
    }

    if (typeof scenario.delay_ms === "number" && scenario.delay_ms > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, scenario.delay_ms));
    }

    if (scenario.write_cwd === true && sentinelPath !== null) {
      await writeFile(`${sentinelPath}.cwd`, `${process.cwd()}\n`, "utf8");
    }

    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "This terminal-shaped message must not become durable evidence.",
        },
      },
    });

    if (Array.isArray(scenario.config_option_update)) {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: scenario.config_option_update,
        },
      });
    }

    const requests = Array.isArray(scenario.requests) ? scenario.requests : [];
    for (let index = 0; index < requests.length; index += 1) {
      const decision = await context.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: {
            toolCallId: `tool-${index + 1}`,
            kind:
              Array.isArray(scenario.request_tool_kinds) &&
              typeof scenario.request_tool_kinds[index] === "string"
                ? scenario.request_tool_kinds[index]
                : "execute",
            status: "pending",
            title: "Controlled capability request",
            rawInput: requests[index],
          },
          options: permissionOptions(),
        },
      );
      if (
        decision.outcome.outcome === "selected" &&
        decision.outcome.optionId === "allow"
      ) {
        if (
          sentinelPath !== null &&
          scenario.write_permission_sentinel !== false
        ) {
          await writeFile(`${sentinelPath}.${index + 1}`, "allowed\n", "utf8");
        }
        if (
          scenario.write_requested_file === true &&
          typeof requests[index]?.path === "string" &&
          typeof scenario.result_source === "string"
        ) {
          await writeFile(requests[index].path, scenario.result_source, "utf8");
        }
      }
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: `tool-${index + 1}`,
          status:
            decision.outcome.outcome === "selected" &&
            decision.outcome.optionId === "allow"
              ? "completed"
              : "failed",
        },
      });
    }
    if (
      typeof scenario.client_write_path === "string" &&
      typeof scenario.client_write_content === "string"
    ) {
      try {
        const writeCount =
          Number.isSafeInteger(scenario.client_write_count) &&
          scenario.client_write_count > 0
            ? scenario.client_write_count
            : 1;
        await Promise.all(
          Array.from({ length: writeCount }, () =>
            context.client.request(acp.methods.client.fs.writeTextFile, {
              sessionId:
                typeof scenario.client_write_session_id === "string"
                  ? scenario.client_write_session_id
                  : sessionId,
              path: scenario.client_write_path,
              content: scenario.client_write_content,
            }),
          ),
        );
      } catch (error) {
        if (scenario.ignore_client_write_error !== true) {
          throw error;
        }
      }
    }
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {});

application.connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
