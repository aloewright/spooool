// TODO Task 14: replace with spooool upload flow. makeStreamer removed (server-side only).
import { TRANSCRIBE_VIDEO } from "../scripts/server/constants";
import {
  MessageTypeId,
  StreamingMessage,
  formatMap,
  messageTypeIdToMessageType,
} from "../scripts/server/streaming";
import { ProcessStatus } from "../components/ProcessingStatus";
import { cancelTranscribeOnServer } from "./cancel-transcribe";
import { parseJsonOrThrowSource } from "./upload-file";

export const transcribeVideoOnServer = async ({
  onProgress,
  endDate,
  selectedFolder,
}: {
  onProgress: (status: ProcessStatus) => void;
  endDate: number;
  selectedFolder: string;
}) => {
  const url = new URL(TRANSCRIBE_VIDEO, window.location.origin);

  url.search = new URLSearchParams({
    folder: selectedFolder,
    endDateAsString: endDate.toString(),
  }).toString();

  // TODO Task 14: implement spooool streaming upload. Stub — throws until replaced.
  throw new Error("transcribeVideoOnServer: not implemented in spooool (Task 14)");
  // eslint-disable-next-line no-unreachable
  const res = await fetch(url, {});
  if (!res.body) {
    throw new Error("No body");
  }
  void res;
};
