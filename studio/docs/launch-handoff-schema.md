# Launch Handoff JSON Schema

`GtmBriefWorkflow` writes each completed launch handoff to `gtm_briefs.content_json` and packages the same JSON into the downloadable ZIP as `handoff.json`.

```ts
type LaunchHandoff = {
  title: string;
  subtitle: string;
  positioning: string;
  comp_titles: string[];
  launch_checklist: string[];
  preorder_copy: {
    headline: string;
    body: string;
  };
  email_sequence: {
    subject: string;
    body: string;
  }[];
  ad_headlines: string[];
  arc_reader_brief: string;
  milestones: {
    week_1: string[];
    month_1: string[];
    month_3: string[];
  };
};
```

The ZIP contains:

- `brief.md`: human-readable launch brief
- `index.html`: rendered preview for handoff review
- `handoff.json`: structured launch handoff data
