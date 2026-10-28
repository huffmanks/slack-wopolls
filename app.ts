import { App, AppOptions, BlockAction, SlackViewAction } from "@slack/bolt";
import { parse } from "json2csv";

interface Question {
  id: string;
  title: string;
  type: "single" | "multi" | "short_text" | "ranked" | "scale";
  options?: string[];
}

interface Poll {
  id: string;
  creatorId: string;
  title: string;
  questions: Question[];
  isAnonymous: boolean;
  isDraft: boolean;
  channelId?: string;
  responses: Record<string, Record<string, any>>;
}

const polls = new Map<string, Poll>();

const appOptions: AppOptions = {
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
};

const app = new App(appOptions);

app.command("/poll", async ({ command, ack, client }) => {
  await ack();

  const pollId = `poll_${Date.now()}`;
  polls.set(pollId, {
    id: pollId,
    creatorId: command.user_id,
    title: "",
    questions: [],
    isAnonymous: false,
    isDraft: true,
    channelId: command.channel_id,
    responses: {},
  });

  await client.views.open({
    trigger_id: command.trigger_id,
    view: buildPollBuilderView(pollId),
  });
});

app.action("add_question", async ({ ack, body, client, action }) => {
  await ack();
  const pollId = (action as any).value;
  const poll = polls.get(pollId);
  if (!poll) return;

  const view = (body as BlockAction).view;
  const values = view?.state.values;
  poll.title = values?.poll_title_block?.poll_title_input?.value || poll.title;
  poll.isAnonymous = (values?.poll_options_block?.poll_options_input?.selected_options || []).some(
    (opt: any) => opt.value === "anonymous",
  );

  poll.questions.push({
    id: `q_${Date.now()}`,
    title: "",
    type: "single",
    options: ["Option 1", "Option 2"],
  });

  await client.views.update({
    view_id: view?.id || "",
    view: buildPollBuilderView(pollId),
  });
});

app.view("submit_poll_builder", async ({ ack, body, view, client }) => {
  const pollId = view.private_metadata;
  const poll = polls.get(pollId);
  if (!poll) {
    await ack();
    return;
  }

  const values = view.state.values;
  poll.title = values.poll_title_block.poll_title_input.value || "Untitled Poll";
  poll.isAnonymous = (values.poll_options_block?.poll_options_input?.selected_options || []).some(
    (opt: any) => opt.value === "anonymous",
  );

  poll.questions = poll.questions.map((q, idx) => {
    const qTitle = values[`q_title_${q.id}`]?.[`q_title_input_${q.id}`]?.value || `Question ${idx + 1}`;
    const qType = (values[`q_type_${q.id}`]?.[`q_type_select_${q.id}`]?.selected_option?.value as any) || "single";
    const rawOpts = values[`q_opts_${q.id}`]?.[`q_opts_input_${q.id}`]?.value;
    const options = rawOpts
      ? rawOpts
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean)
      : q.options;

    return { ...q, title: qTitle, type: qType, options };
  });

  poll.isDraft = false;

  await ack();

  const isDM = (values.poll_options_block?.poll_options_input?.selected_options || []).some(
    (opt: any) => opt.value === "dm",
  );

  if (isDM) {
    await client.chat.postMessage({
      channel: poll.creatorId,
      blocks: buildPollBlocks(poll),
      text: `Poll: ${poll.title}`,
    });
  } else if (poll.channelId) {
    await client.chat.postMessage({
      channel: poll.channelId,
      blocks: buildPollBlocks(poll),
      text: `Poll: ${poll.title}`,
    });
  }
});

app.action(/^vote_/, async ({ ack, body, action, client }) => {
  await ack();
  const act = action as any;
  const [_, pollId, qId] = act.action_id.split("_");
  const poll = polls.get(pollId);
  if (!poll) return;

  const userId = body.user.id;
  if (!poll.responses[userId]) poll.responses[userId] = {};

  if (act.type === "static_select") {
    poll.responses[userId][qId] = act.selected_option.value;
  } else if (act.type === "multi_static_select") {
    poll.responses[userId][qId] = act.selected_options.map((o: any) => o.value);
  }

  await updatePollMessage(client, body, poll);
});

app.action(/^export_csv_/, async ({ ack, body, action, client }) => {
  await ack();
  const pollId = (action as any).action_id.replace("export_csv_", "");
  const poll = polls.get(pollId);
  if (!poll) return;

  const records: Record<string, any>[] = [];

  Object.entries(poll.responses).forEach(([userId, answers]) => {
    const row: Record<string, any> = {
      User: poll.isAnonymous ? "Anonymous" : userId,
    };
    poll.questions.forEach((q) => {
      const ans = answers[q.id];
      row[q.title] = Array.isArray(ans) ? ans.join("; ") : ans || "";
    });
    records.push(row);
  });

  const csv = parse(records.length ? records : [{}]);
  const buffer = Buffer.from(csv, "utf-8");

  await client.files.uploadV2({
    channel_id: body.user.id,
    filename: `${poll.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_results.csv`,
    file: buffer,
    title: `${poll.title} - Results CSV`,
  });
});

function buildPollBuilderView(pollId: string): SlackViewAction | any {
  const poll = polls.get(pollId)!;

  const blocks: any[] = [
    {
      type: "input",
      block_id: "poll_title_block",
      element: {
        type: "plain_text_input",
        action_id: "poll_title_input",
        initial_value: poll.title,
        placeholder: { type: "plain_text", text: "Enter poll title or topic" },
      },
      label: { type: "plain_text", text: "Poll Title" },
    },
    {
      type: "checkboxes",
      block_id: "poll_options_block",
      element: {
        type: "checkboxes",
        action_id: "poll_options_input",
        options: [
          {
            text: { type: "plain_text", text: "Anonymous Responses" },
            value: "anonymous",
          },
          {
            text: { type: "plain_text", text: "Send via DM instead of Channel" },
            value: "dm",
          },
        ],
      },
      label: { type: "plain_text", text: "Settings" },
    },
    { type: "divider" },
  ];

  poll.questions.forEach((q, idx) => {
    blocks.push(
      {
        type: "input",
        block_id: `q_title_${q.id}`,
        element: {
          type: "plain_text_input",
          action_id: `q_title_input_${q.id}`,
          initial_value: q.title,
          placeholder: { type: "plain_text", text: `Question ${idx + 1}` },
        },
        label: { type: "plain_text", text: `Question ${idx + 1}` },
      },
      {
        type: "input",
        block_id: `q_type_${q.id}`,
        element: {
          type: "static_select",
          action_id: `q_type_select_${q.id}`,
          initial_option: {
            text: { type: "plain_text", text: getTypeName(q.type) },
            value: q.type,
          },
          options: [
            { text: { type: "plain_text", text: "Single Select" }, value: "single" },
            { text: { type: "plain_text", text: "Multi Select" }, value: "multi" },
            { text: { type: "plain_text", text: "Short Answer" }, value: "short_text" },
            { text: { type: "plain_text", text: "Ranked Choice" }, value: "ranked" },
            { text: { type: "plain_text", text: "Scale Rating (1-5)" }, value: "scale" },
          ],
        },
        label: { type: "plain_text", text: "Type" },
      },
      {
        type: "input",
        block_id: `q_opts_${q.id}`,
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: `q_opts_input_${q.id}`,
          initial_value: q.options?.join(", ") || "",
          placeholder: { type: "plain_text", text: "Option 1, Option 2, Option 3" },
        },
        label: { type: "plain_text", text: "Options (comma-separated, if applicable)" },
      },
    );
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "+ Add Question" },
        value: pollId,
        action_id: "add_question",
      },
    ],
  });

  return {
    type: "modal",
    callback_id: "submit_poll_builder",
    private_metadata: pollId,
    title: { type: "plain_text", text: "Create a Poll" },
    submit: { type: "plain_text", text: "Publish Poll" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

function buildPollBlocks(poll: Poll): any[] {
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📊 ${poll.title}` },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Created by <@${poll.creatorId}> | ${poll.isAnonymous ? "🔒 Anonymous" : "👥 Public Responses"}`,
        },
      ],
    },
    { type: "divider" },
  ];

  poll.questions.forEach((q) => {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${q.title}*` },
    });

    if (q.type === "single" && q.options) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "static_select",
            action_id: `vote_${poll.id}_${q.id}`,
            placeholder: { type: "plain_text", text: "Choose an option..." },
            options: q.options.map((opt) => ({
              text: { type: "plain_text", text: opt },
              value: opt,
            })),
          },
        ],
      });
    } else if (q.type === "multi" && q.options) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "multi_static_select",
            action_id: `vote_${poll.id}_${q.id}`,
            placeholder: { type: "plain_text", text: "Select options..." },
            options: q.options.map((opt) => ({
              text: { type: "plain_text", text: opt },
              value: opt,
            })),
          },
        ],
      });
    } else if (q.type === "scale") {
      blocks.push({
        type: "actions",
        elements: [1, 2, 3, 4, 5].map((num) => ({
          type: "button",
          text: { type: "plain_text", text: `${num}` },
          value: `${num}`,
          action_id: `vote_${poll.id}_${q.id}_${num}`,
        })),
      });
    }
  });

  const responseCount = Object.keys(poll.responses).length;
  blocks.push(
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📥 Export CSV" },
          action_id: `export_csv_${poll.id}`,
        },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `*Total Responses:* ${responseCount}` }],
    },
  );

  return blocks;
}

async function updatePollMessage(client: any, body: any, poll: Poll) {
  if (body.message?.ts && body.channel?.id) {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      blocks: buildPollBlocks(poll),
      text: `Poll: ${poll.title}`,
    });
  }
}

function getTypeName(type: string): string {
  const map: Record<string, string> = {
    single: "Single Select",
    multi: "Multi Select",
    short_text: "Short Answer",
    ranked: "Ranked Choice",
    scale: "Scale Rating (1-5)",
  };
  return map[type] || "Single Select";
}

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Slack Poll App is running!");
})();
