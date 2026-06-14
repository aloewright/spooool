import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { type Project, type Voice, api, queryKeys } from "../../lib/api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { POSTPILOT_SUGGESTIONS, postPilotGuideLabel } from "./_shared";

export default function VoicePanel({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [sample, setSample] = useState("");
  const [newSample, setNewSample] = useState("");
  const [postPilotSlug, setPostPilotSlug] = useState("dickens");
  const [selectedVoiceId, setSelectedVoiceId] = useState(project.voice_id ?? "");
  const voices = useQuery({
    queryKey: queryKeys.voices(),
    queryFn: api.listVoices,
  });
  const postPilotGuides = useQuery({
    queryKey: queryKeys.postPilotGuides(),
    queryFn: api.listPostPilotGuides,
  });
  const selectedVoice = useQuery({
    queryKey: queryKeys.voice(selectedVoiceId),
    queryFn: () => api.getVoice(selectedVoiceId),
    enabled: Boolean(selectedVoiceId),
  });

  const selected = selectedVoice.data;
  const postPilotGuideOptions = postPilotGuides.data?.items.length
    ? postPilotGuides.data.items
    : POSTPILOT_SUGGESTIONS;
  const totalWords = useMemo(
    () => selected?.samples?.reduce((sum, item) => sum + item.word_count, 0) ?? 0,
    [selected],
  );

  const createVoice = useMutation({
    mutationFn: async () => {
      const voice = await api.createVoice({
        name,
        samples: sample.trim() ? [{ source: "paste", text: sample }] : [],
      });
      await api.updateProject(project.id, { voice_id: voice.id });
      return voice;
    },
    onSuccess: async ({ id }) => {
      setName("");
      setSample("");
      setSelectedVoiceId(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.voices() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) }),
      ]);
    },
  });

  const assignVoice = useMutation({
    mutationFn: (voiceId: string) => api.updateProject(project.id, { voice_id: voiceId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) }),
  });

  const importPostPilot = useMutation({
    mutationFn: async () => {
      const voice = await api.importPostPilotVoice({ slug: postPilotSlug });
      await api.updateProject(project.id, { voice_id: voice.id });
      return voice;
    },
    onSuccess: async ({ id }) => {
      setSelectedVoiceId(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.voices() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) }),
      ]);
    },
  });

  const addSample = useMutation({
    mutationFn: () => api.addVoiceSample(selectedVoiceId, { source: "paste", text: newSample }),
    onSuccess: async () => {
      setNewSample("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.voice(selectedVoiceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.voices() }),
      ]);
    },
  });

  return (
    <div id="voice" className="flex w-full scroll-mt-6 flex-col gap-8">
      <section className="border-b pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Voice library</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Build reusable author voices from pasted samples. Architect and Writer use the
              selected voice for outline and draft generation.
            </p>
          </div>
          {project.voice_id ? (
            <Badge>Voice selected</Badge>
          ) : (
            <Badge variant="secondary">No voice</Badge>
          )}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
        <form
          className="rounded-lg border bg-background p-4"
          onSubmit={(event) => {
            event.preventDefault();
            createVoice.mutate();
          }}
        >
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Create custom voice</h2>
            <p className="text-sm text-muted-foreground">
              Paste at least 1,500 words for distillation.
            </p>
          </div>
          <div className="mt-4 space-y-3">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Voice name"
              required
            />
            <Textarea
              value={sample}
              onChange={(event) => setSample(event.target.value)}
              placeholder="Paste sample text"
              className="min-h-56 resize-y"
            />
            <Button type="submit" disabled={!name.trim() || createVoice.isPending}>
              {createVoice.isPending ? "Creating..." : "Create voice"}
            </Button>
            {createVoice.error ? (
              <p className="text-sm text-destructive">{createVoice.error.message}</p>
            ) : null}
          </div>
        </form>

        <div className="space-y-4">
          <div className="rounded-lg border bg-background p-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold">Import from Post Pilot</h2>
              <p className="text-sm text-muted-foreground">
                Clone an author style guide into your local voice library.
              </p>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
              <Select value={postPilotSlug} onValueChange={setPostPilotSlug}>
                <SelectTrigger aria-label="Post Pilot author">
                  <SelectValue
                    placeholder={postPilotGuides.isLoading ? "Loading guides..." : "Choose a guide"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {postPilotGuideOptions.map((item) => (
                    <SelectItem key={item.slug} value={item.slug}>
                      {postPilotGuideLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="secondary"
                disabled={importPostPilot.isPending}
                onClick={() => importPostPilot.mutate()}
              >
                {importPostPilot.isPending ? "Importing..." : "Import"}
              </Button>
            </div>
            <Input
              value={postPilotSlug}
              onChange={(event) => setPostPilotSlug(event.target.value)}
              placeholder="custom-slug"
              className="mt-3"
            />
            {postPilotGuides.error ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Could not load the full Post Pilot author list. Use a custom slug to import a guide.
              </p>
            ) : null}
            {importPostPilot.error ? (
              <p className="mt-3 text-sm text-destructive">{importPostPilot.error.message}</p>
            ) : null}
          </div>

          <div className="rounded-lg border bg-background p-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold">Project voice</h2>
              <p className="text-sm text-muted-foreground">
                Choose the voice attached to this book.
              </p>
            </div>
            <div className="mt-4 flex gap-3">
              <Select
                value={selectedVoiceId}
                disabled={assignVoice.isPending}
                onValueChange={(value) => {
                  assignVoice.mutate(value, {
                    onSuccess: () => setSelectedVoiceId(value),
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a voice" />
                </SelectTrigger>
                <SelectContent>
                  {(voices.data?.items ?? []).map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>
                      {voice.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {assignVoice.error ? (
              <p className="mt-3 text-sm text-destructive">{assignVoice.error.message}</p>
            ) : null}
          </div>

          <VoiceProfile voice={selected} totalWords={totalWords} />
          {selected ? (
            <form
              className="rounded-lg border bg-background p-4"
              onSubmit={(event) => {
                event.preventDefault();
                addSample.mutate();
              }}
            >
              <div className="space-y-1">
                <h2 className="text-base font-semibold">Add sample</h2>
                <p className="text-sm text-muted-foreground">
                  Add more corpus text to improve the profile.
                </p>
              </div>
              <div className="mt-4 space-y-3">
                <Textarea
                  value={newSample}
                  onChange={(event) => setNewSample(event.target.value)}
                  placeholder="Paste another sample"
                  className="min-h-32 resize-y"
                />
                <Button type="submit" disabled={!newSample.trim() || addSample.isPending}>
                  {addSample.isPending ? "Adding..." : "Add sample"}
                </Button>
                {addSample.error ? (
                  <p className="text-sm text-destructive">{addSample.error.message}</p>
                ) : null}
              </div>
            </form>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function VoiceProfile({ voice, totalWords }: { voice?: Voice; totalWords: number }) {
  if (!voice) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-sm text-muted-foreground">
        Create or select a voice to see its profile and sample corpus.
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{voice.name}</h2>
          <p className="text-sm text-muted-foreground">
            {voice.samples?.length ?? 0} samples, {totalWords.toLocaleString()} words
          </p>
        </div>
        <Badge variant={totalWords >= 1500 ? "default" : "secondary"}>
          {totalWords >= 1500 ? "Distilled" : "Needs more sample"}
        </Badge>
      </div>
      <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-4 text-sm leading-6">
        {voice.profile_md || "No profile yet."}
      </pre>
    </div>
  );
}
