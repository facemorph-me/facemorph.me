import { msg, type Msg } from '../msg.ts';
import type { State, Input, Output, Progress } from '../state.ts';
import { unchanged, viewSnapshot, type Transition, type Effect } from '../effects.ts';
import {
  predictedMorphMs,
  isSlowDevice,
  remainingText,
  describeDuration,
  type Measurements,
  faceInputProblem,
  gateScope,
} from '../derived.ts';
import { enqueue, without, sameInputs, settingsKey, schedule, runFace } from './schedule.ts';

/** The manager's refusal texts for a file outside every approved grant (acquisition/grants.ts GrantRefused). */
const GRANT_REFUSAL = /not covered by an approved download|needs more data than was approved/;
/**
 * A model download that failed after approval (fm-9kr8), said in plain words. The manager keeps every verified
 * chunk, so Try again fetches only the rest; the error box adds what is kept and what remains (derived.ts downloadKept).
 */
export function acquisitionFailure(error: string): string | null {
  const damaged = /integrity mismatch|exceeds declared size/i.test(error);
  const storage = /QuotaExceeded|browser storage to save/i.test(error);
  if (
    !damaged &&
    !storage &&
    !/model download|model file could not be downloaded|stopped receiving data/i.test(error)
  )
    return null;
  return damaged ? ACQUISITION_DAMAGED : storage ? ACQUISITION_STORAGE : error;
}
/** A result made while the model could not be saved (fm-9kr8): said as storage, never as a device limit. */
export const MODEL_NOT_KEPT =
  'This browser could not keep the downloaded model (its storage is full, or this is a private window), so it downloads again next time.';
export const ACQUISITION_DAMAGED =
  'A downloaded model file arrived damaged, so it was not used. Parts already downloaded are kept.';
export const ACQUISITION_STORAGE =
  'This device ran out of browser storage while saving the model. Free some storage, then try again. Parts already saved are kept.';
/** Whether an error box shows a failed model download, so it can say what is kept and what remains. */
export const isAcquisitionFailure = (error: string | null): boolean =>
  !!error &&
  (error === ACQUISITION_DAMAGED ||
    error === ACQUISITION_STORAGE ||
    /model download|model file could not be downloaded|stopped receiving data/i.test(error));

export interface JobFacts {
  readonly measurements?: Measurements;
  readonly progress?: {
    readonly facesTotal: number;
    readonly facesDone: number;
    readonly framesTotal: number;
    readonly framesDone: number;
    readonly videoFramesTotal: number;
    readonly videoFramesDone: number;
  };
  readonly multipleFacesMessage?: string;
}
const emptyMeasurements: Measurements = {
  faceMs: null,
  frameMs: null,
  videoMs: null,
  plannedFrames: null,
};
export function restored(state: State, result: Output, clearPreviews = true): State {
  return {
    ...state,
    Inputs: result.inputs,
    Faces: result.faces,
    VideoUrl: result.videoUrl,
    Previews: clearPreviews ? [] : state.Previews,
    Status: result.message,
    Kind: result.kind || state.Kind,
    Width: result.width,
    Pinch: result.pinch,
    Frames: result.frames,
    Fps: result.fps,
  };
}
/**
 * The arrival restore. The session keeps every slot's id but only the faces that were made, so a slot that was never
 * generated (the "hello" preview a first visit shows, or the dated second face) came back as an empty word field:
 * marked invalid before the visitor typed anything, its preview gone and Create morph disabled under a "Welcome
 * back" line. Such a slot keeps this arrival's own words and preview instead; restored faces are unchanged.
 */
function arrivalRestored(state: State, result: Output): State {
  const made = new Set(result.faces.map((face) => face.id));
  const inputs = result.inputs.map((input) =>
    made.has(input.id) || input.mode !== 'text' || input.value !== ''
      ? input
      : (state.Inputs.find((item) => item.id === input.id) ?? input),
  );
  return {
    ...restored(state, { ...result, inputs }),
    Previews: state.Previews.filter(
      (preview) =>
        !made.has(preview.id) &&
        inputs.some(
          (input) =>
            input.id === preview.id && input.mode === preview.mode && input.value === preview.value,
        ),
    ),
  };
}
export function cancelled(state: State, jobId: number): Transition {
  return jobId !== state.JobId
    ? unchanged(state)
    : schedule({
        ...state,
        Busy: false,
        Stage: 'done',
        Status: 'Cancelled. Your completed faces are still available.',
        Fraction: state.Fraction,
        ActiveFace: null,
        Error: null,
        FailureToast: false,
        Warn: null,
        Remaining: '',
      });
}
export function jobs(message: Msg, state: State, facts: JobFacts = {}): Transition | null {
  switch (message.type) {
    case 'RunFace': {
      const [id] = message.args;
      const input = state.Inputs.find((item) => item.id === id);
      if (!input || faceInputProblem(input) || state.Faces.some((face) => face.id === id))
        return unchanged(state);
      if (state.Busy || state.PreparingFaces.has(id))
        return {
          state: {
            ...state,
            PendingFaces: [...new Set([...state.PendingFaces, id])],
            PendingJobs: enqueue(state.PendingJobs, message),
          },
          effects: [{ type: 'queueFace', id, depth: state.PendingFaces.length + 1 }],
        };
      return start(state, message, 'face', [input], id);
    }
    case 'Run': {
      const [action] = message.args;
      if (state.Inputs.some((input) => faceInputProblem(input))) return unchanged(state);
      // One current morph (fm-8w99): pressing Morph again while that same morph runs (same faces and settings)
      // is the running intent, not a second one queued behind it.
      if (
        action === 'morph' &&
        state.Busy &&
        state.LastRun?.type === 'Run' &&
        state.LastRun.args[0] === 'morph' &&
        state.RunSettings === settingsKey(state) &&
        sameInputs(state.RunInputs, state.Inputs)
      )
        return unchanged(state);
      if (
        action === 'morph' &&
        (state.Busy || state.PreparingFaces.size > 0 || state.Crop !== null)
      )
        return {
          state: { ...state, PendingMorph: true, PendingJobs: enqueue(state.PendingJobs, message) },
          effects: [],
        };
      if (state.Busy) return unchanged(state);
      if (action !== 'morph' && action !== 'faces')
        throw new RangeError('Unknown controller action');
      const measured = facts.measurements ?? emptyMeasurements;
      const predicted = predictedMorphMs(state, measured);
      const warn =
        action !== 'morph'
          ? null
          : predicted !== null && predicted > 30_000
            ? `This video may take ${describeDuration(predicted)} on this device. It keeps going if you switch tabs, and you can cancel at any time.`
            : isSlowDevice(state, measured.faceMs)
              ? 'Generating is slow on this device, so this video may take a while. You can cancel at any time.'
              : null;
      return start(state, message, action, state.Inputs, '', warn);
    }
    case 'CancelFace': {
      const [id] = message.args;
      const next = {
        ...state,
        PendingJobs: without(state.PendingJobs, runFace(id)),
        PendingFaces: state.PendingFaces.filter((item) => item !== id),
      };
      if (state.ActiveFace === id)
        return {
          state: { ...next, Stage: 'cancelling' },
          effects: [{ type: 'cancelQueuedFace', id }, { type: 'cancelWork' }],
        };
      const preparing = new Set(state.PreparingFaces);
      preparing.delete(id);
      // Its confirmed crop is still being made: it lands for Retry (fm-zigt), but does not encode.
      if (state.CropsPending?.has(id))
        return schedule(
          {
            ...next,
            PreparingFaces: preparing,
            CropsHeld: new Set([...(state.CropsHeld ?? []), id]),
          },
          [{ type: 'cancelQueuedFace', id }],
        );
      return schedule({ ...next, PreparingFaces: preparing }, [
        { type: 'cancelQueuedFace', id },
        { type: 'invalidateFace', id },
        { type: 'invalidatePhotoSelections', id },
      ]);
    }
    case 'Cancel':
      return state.Busy
        ? {
            state: { ...state, Stage: 'cancelling', Status: 'Cancelling…' },
            effects: [{ type: 'cancelWork' }],
          }
        : unchanged(state);
    case 'RestoredLast': {
      const [result] = message.args;
      if (state.JobId !== 0 || state.RunInputs.length > 0 || state.Inputs[0]?.value !== 'hello')
        return unchanged(state);
      return {
        state: arrivalRestored(state, result),
        effects: state.UseSlider && result.videoUrl ? [{ type: 'sliderFrames' }] : [],
      };
    }
    case 'Progressed':
      return progressed(message.args[0], state, facts);
    case 'Completed': {
      const [id, result] = message.args;
      if (id !== state.JobId) return unchanged(state);
      if (result.cropFace && !state.Inputs.some((input) => input.id === result.cropFace))
        return cancelled(state, id);
      if (result.cropFace)
        return schedule(
          {
            ...state,
            Busy: false,
            ActiveFace: null,
            Status: 'Crop to a clear face to continue.',
            Fraction: 0,
            PreparingFaces: new Set([...state.PreparingFaces, result.cropFace]),
          },
          [{ type: 'dispatch', message: msg('RequestCrop', result.cropFace), continuation: true }],
        );
      const output = result.restored ? restored(state, result, false) : state;
      return schedule(
        {
          ...output,
          Busy: false,
          Faces: result.restored
            ? result.faces
            : result.faces.filter((face) => state.Inputs.some((input) => input.id === face.id)),
          VideoUrl:
            sameInputs(state.RunInputs, state.Inputs) && state.RunSettings === settingsKey(state)
              ? result.videoUrl
              : '',
          Status:
            state.Downloads.modelNotKept && !result.errorMessage
              ? `${result.message} ${MODEL_NOT_KEPT}`.trim()
              : result.message,
          Error: result.errorMessage || null,
          FailureToast: Boolean(result.errorMessage) && !state.Debug,
          Stage: result.errorMessage ? 'error' : 'done',
          Fraction: result.errorMessage ? state.Fraction : 1,
          Warn: null,
          Remaining: '',
          ActiveFace: null,
        },
        result.videoUrl && state.UseSlider ? [{ type: 'sliderFrames' }] : [],
      );
    }
    case 'Failed': {
      const [id, error] = message.args;
      if (id !== state.JobId) return unchanged(state);
      // A model file the approval does not cover (packages/browser-model-manager GrantRefused: another route's files,
      // a shard past the advertised size, an evicted file) is a new cost, so the question is asked again for this run
      // rather than shown as a failure (fm-qrfz).
      if (GRANT_REFUSAL.test(error) && state.LastRun) {
        // The video worker names a refused codec with its bytes (fm-9kr8): the question then asks for them in Generate.
        const codec = /^The video codec \((\d+) bytes\)/.exec(error);
        const asked = {
          ...state,
          DownloadConsent: new Set<string>(),
          ...(codec
            ? { MorphCodec: { run: state.LastRun, needed: true, bytes: Number(codec[1]) } }
            : {}),
        };
        const scope =
          gateScope({ ...asked, Downloads: { ...state.Downloads, known: false } }, state.LastRun) ??
          'route';
        return {
          state: {
            ...asked,
            Busy: false,
            Error: null,
            Status: '',
            Stage: 'idle',
            Fraction: 0,
            Warn: null,
            Remaining: '',
            ActiveFace: null,
            Gate: [scope, state.LastRun],
          },
          effects: [],
        };
      }
      if (error === facts.multipleFacesMessage && state.ActiveFace !== null) {
        if (!state.Inputs.some((input) => input.id === state.ActiveFace))
          return cancelled(state, id);
        return {
          state: {
            ...state,
            Busy: false,
            Error: null,
            Status: 'Crop to one face to continue.',
            Stage: 'idle',
            Fraction: 0,
            Warn: null,
            Remaining: '',
            ActiveFace: null,
          },
          effects: [
            { type: 'dispatch', message: msg('RequestCrop', state.ActiveFace), continuation: true },
          ],
        };
      }
      const said = acquisitionFailure(error) ?? error;
      return schedule({
        ...state,
        // The bridge re-measures the verified files after a failed job; until then the kept figure is not known.
        KeptPending: isAcquisitionFailure(said),
        Busy: false,
        Error: said,
        Status: state.LastRun?.type === 'Run' && state.LastRun.args[0] === 'morph' ? said : '',
        Stage: 'error',
        Fraction: state.Fraction,
        Warn: null,
        Remaining: '',
        ActiveFace: null,
        FailureToast: !state.Debug,
      });
    }
    case 'Save':
    case 'Share':
      return {
        state,
        effects: [
          { type: message.type === 'Save' ? 'saveMedia' : 'shareMedia', id: message.args[0] },
        ],
      };
    case 'Export':
      return state.Busy
        ? unchanged(state)
        : { state, effects: [{ type: 'exportProject', view: viewSnapshot(state) }] };
    case 'Import': {
      const [file] = message.args;
      if (state.Busy)
        return {
          state: {
            ...state,
            PendingImport: file,
            PendingJobs: enqueue(state.PendingJobs, message),
          },
          effects: [],
        };
      const id = state.JobId + 1;
      return {
        state: {
          ...state,
          Busy: true,
          JobId: id,
          Stage: 'importing',
          PendingImport: null,
          PendingJobs: without(state.PendingJobs, message),
          Status: 'Opening project…',
          RunInputs: state.Inputs,
          RunSettings: '',
        },
        effects: [
          {
            type: 'importProject',
            file,
            jobId: id,
            provider: state.Provider,
            view: viewSnapshot(state),
          },
        ],
      };
    }
    case 'Notice':
      // A repeated notice (a second Save of the same file) changes nothing, so nothing re-renders.
      return message.args[0] === state.Status
        ? unchanged(state)
        : { state: { ...state, Status: message.args[0] }, effects: [] };
    case 'Retry':
      return state.Busy
        ? unchanged(state)
        : {
            state: { ...state, Error: null, FailureToast: false },
            effects: state.LastRun ? [{ type: 'dispatch', message: state.LastRun }] : [],
          };
    default:
      return null;
  }
}
function start(
  state: State,
  message: Msg,
  action: 'face' | 'faces' | 'morph',
  inputs: readonly Input[],
  target: string,
  warn: string | null = null,
): Transition {
  const id = state.JobId + 1;
  const effects: Effect[] =
    action === 'face' ? [{ type: 'rememberView', view: viewSnapshot(state) }] : [];
  effects.push({
    type: 'execute',
    request: {
      ...viewSnapshot(state),
      inputs,
      jobId: id,
      action,
      target,
      provider: state.Provider,
    },
  });
  return {
    state: {
      ...state,
      Busy: true,
      JobId: id,
      LastRun: message,
      FailureToast: false,
      Error: null,
      Stage: 'preparing',
      Status: action === 'face' ? 'Generating this face…' : 'Preparing…',
      ...(action === 'face' ? {} : { Disclosure: '' }),
      ActiveFace: action === 'face' ? target : null,
      RunInputs: inputs,
      RunSettings: action === 'face' ? '' : settingsKey(state),
      PendingJobs: without(
        state.PendingJobs,
        action === 'face' ? runFace(target) : msg('Run', 'morph'),
      ),
      PendingFaces:
        action === 'face'
          ? state.PendingFaces.filter((face) => face !== target)
          : state.PendingFaces,
      PendingMorph: action === 'face' ? state.PendingMorph : false,
      // The frame plan is unknown until the actual morph planner reports its total.
      Fraction: action === 'morph' ? -1 : 0,
      VideoUrl: action === 'face' ? '' : state.VideoUrl,
      Warn: warn,
      Remaining: '',
      SliderFrames: null,
      SliderFrame: 1,
    },
    effects,
  };
}
function progressed(progress: Progress, state: State, facts: JobFacts): Transition {
  if (progress.stage === 'frames-available' && progress.jobId === state.JobId)
    return { state, effects: [{ type: 'sliderFrames' }] };
  if (progress.stage.startsWith('diagnostics-')) {
    const status =
      progress.stage === 'diagnostics-sent'
        ? `Report saved. Reference: ${progress.text}`
        : progress.stage === 'diagnostics-failed'
          ? 'Report could not be saved. You can still email us.'
          : progress.stage === 'diagnostics-enabled'
            ? 'Reporting is on. It stays on until you turn it off.'
            : 'Reporting is off.';
    return {
      state: {
        ...state,
        DebugStatus: status,
        Debug:
          progress.stage === 'diagnostics-enabled'
            ? true
            : progress.stage === 'diagnostics-disabled'
              ? false
              : state.Debug,
        ConsentPrompt: progress.stage === 'diagnostics-enabled' ? false : state.ConsentPrompt,
      },
      effects: [],
    };
  }
  if (progress.stage === 'route-admitted')
    return { state: { ...state, Route: progress.text }, effects: [] };
  if (progress.stage === 'route-rejected')
    return { state: { ...state, Rejected: progress.text }, effects: [] };
  if (progress.stage === 'photo-acquisition' || progress.stage === 'photo-tools-ready')
    return { state: { ...state, Preparing: state.Busy ? '' : progress.text }, effects: [] };
  if (!state.Busy || progress.jobId !== state.JobId) return unchanged(state);
  return {
    state: {
      ...state,
      Stage: progress.stage,
      Status: progress.text,
      Fraction: progress.fraction,
      ActiveFace: progress.stage === 'face' && progress.face ? progress.face : state.ActiveFace,
      // The device check runs several syntheses before the first face; a per-face estimate during it
      // said "about 3 seconds remaining" for most of a minute.
      Remaining:
        facts.progress && progress.stage !== 'canary'
          ? remainingText(state, facts.measurements ?? emptyMeasurements, facts.progress)
          : '',
    },
    effects: [],
  };
}
