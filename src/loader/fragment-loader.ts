import { ErrorTypes, ErrorDetails } from '../errors';
import Fragment from './fragment';
import {
  Loader,
  LoaderConfiguration,
  FragmentLoaderContext,
  LoaderContext
} from '../types/loader';
import { reset } from './load-stats';
import type { HlsConfig } from '../config';
import type { BaseSegment, Part } from './fragment';

const MIN_CHUNK_SIZE = Math.pow(2, 17); // 128kb

export default class FragmentLoader {
  private readonly config: HlsConfig;
  private loader: Loader<FragmentLoaderContext> | null = null;
  private partLoadTimeout: number = -1;
  private nextPartIndex: number = -1;
  public updateLiveFragment: ((newFragment: Fragment) => void) | null = null;

  constructor (config: HlsConfig) {
    this.config = config;
  }

  abort () {
    if (this.loader) {
      // Abort the loader for current fragment. Only one may load at any given time
      this.loader.abort();
    }
  }

  load (frag: Fragment, targetBufferTime: number | null = null, onProgress?: FragmentLoadProgressCallback): Promise<FragLoadSuccessResult> {
    const url = frag.url;
    if (!url && !frag.hasParts) {
      return Promise.reject(new LoadError({
        type: ErrorTypes.NETWORK_ERROR,
        details: ErrorDetails.INTERNAL_EXCEPTION,
        fatal: false,
        frag,
        networkDetails: null
      }, `Fragment does not have a ${url ? 'part list' : 'url'}`));
    }

    const config = this.config;
    const FragmentILoader = config.fLoader;
    const DefaultILoader = config.loader;

    this.abort();

    const loader = this.loader = frag.loader =
      FragmentILoader ? new FragmentILoader(config) : new DefaultILoader(config) as Loader<FragmentLoaderContext>;

    const loaderConfig: LoaderConfiguration = {
      timeout: config.fragLoadingTimeOut,
      maxRetry: 0,
      retryDelay: 0,
      maxRetryDelay: config.fragLoadingMaxRetryTimeout,
      highWaterMark: MIN_CHUNK_SIZE
    };

    if (frag.hasParts && !frag.hasAllParts && onProgress) {
      return this.loadFragmentParts(frag, targetBufferTime || 0, loaderConfig, onProgress);
    }

    const loaderContext = createLoaderContext(frag);

    return new Promise((resolve, reject) => {
      // Assign frag stats to the loader's stats reference
      loader.stats = frag.stats;
      loader.load(loaderContext, loaderConfig, {
        onSuccess: (response, stats, context, networkDetails) => {
          this.resetLoader(frag, loader);
          resolve({
            payload: response.data as ArrayBuffer,
            networkDetails
          });
        },
        onError: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(new LoadError({
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.FRAG_LOAD_ERROR,
            fatal: false,
            frag,
            response,
            networkDetails
          }));
        },
        onAbort: (stats, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(new LoadError({
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.INTERNAL_ABORTED,
            fatal: false,
            frag,
            networkDetails
          }));
        },
        onTimeout: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(new LoadError({
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.FRAG_LOAD_TIMEOUT,
            fatal: false,
            frag,
            networkDetails
          }));
        },
        onProgress: (stats, context, data, networkDetails) => {
          if (onProgress) {
            onProgress({
              payload: data as ArrayBuffer,
              networkDetails
            });
          }
        }
      });
    });
  }

  private loadFragmentParts (frag: Fragment, targetBufferTime: number, loaderConfig: LoaderConfiguration, onProgress: FragmentLoadProgressCallback): Promise<FragLoadSuccessResult> {
    reset(frag.stats);

    // Start loading parts at `targetBufferTime`
    targetBufferTime = Math.max(frag.start, targetBufferTime);
    const part = frag.findIndependentPart(targetBufferTime) || frag.partList![0];

    return new Promise((resolve, reject) => {
      if (!part) {
        return reject(new LoadError({
          type: ErrorTypes.NETWORK_ERROR,
          details: ErrorDetails.INTERNAL_ABORTED,
          fatal: false,
          frag,
          networkDetails: null
        }, `Could not find fragment part at ${targetBufferTime}`));
      }
      const loader = this.loader as Loader<FragmentLoaderContext>;
      this.partLoadTimeout = self.setTimeout(() => {
        this.resetLoader(frag, loader);
        reject(new LoadError({
          type: ErrorTypes.NETWORK_ERROR,
          details: ErrorDetails.FRAG_LOAD_TIMEOUT,
          fatal: false,
          frag,
          part,
          networkDetails: loader.loader
        }));
      }, loaderConfig.timeout);

      // Get updated fragment with additional parts from merging live playlists
      this.nextPartIndex = -1;
      this.updateLiveFragment = (newFragment: Fragment) => {
        const loadingParts = this.nextPartIndex !== -1;
        if (newFragment.partList) {
          frag.partList = newFragment.partList;
        } else if (loadingParts) {
          // Fragment parts are no longer available
          this.abort();
          return;
        }
        // nextPartIndex is set when we're waiting for the next part
        if (loadingParts) {
          const nextPart = newFragment.partList ? newFragment.partList[this.nextPartIndex] : null;
          if (nextPart) {
            newFragment.loader = loader;
            this.loadPart(newFragment, nextPart, loader, loaderConfig, onProgress, resolve, reject);
          } else if (newFragment.hasAllParts) {
            // Fragment is complete
            this.resetLoader(frag, loader);
            resolve({
              payload: new ArrayBuffer(0),
              networkDetails: loader.loader
            });
          }
        }
      };

      this.loadPart(frag, part, loader, loaderConfig, onProgress, resolve, reject);
    });
  }

  private loadPart (frag: Fragment, part: Part, loader: Loader<FragmentLoaderContext>, loaderConfig: LoaderConfiguration, onProgress: FragmentLoadProgressCallback, resolve: (value: FragLoadSuccessResult) => void, reject: (reason: LoadError) => void) {
    const loaderContext = createLoaderContext(frag, part);

    // Assign frag stats to the loader's stats reference
    loader.stats = part.stats;
    loader.load(loaderContext, loaderConfig, {
      onSuccess: (response, stats, context, networkDetails) => {
        frag.stats.loaded += part.stats.loaded;
        if (frag.stats.loading.start) {
          frag.stats.loading.start += part.stats.loading.start - frag.stats.loading.end;
          frag.stats.loading.first += part.stats.loading.first - frag.stats.loading.end;
        } else {
          frag.stats.loading.start = part.stats.loading.start;
          frag.stats.loading.first = part.stats.loading.first;
        }
        frag.stats.loading.end = part.stats.loading.end;
        onProgress({
          payload: response.data as ArrayBuffer,
          networkDetails
        });

        if (frag.isFinalPart(part)) {
          this.resetLoader(frag, loader);
          resolve({
            payload: response.data as ArrayBuffer,
            networkDetails
          });
        } else if (this.updateLiveFragment) {
          // Load or wait to load the next part
          this.nextPartIndex = part.index + 1;
          this.updateLiveFragment(frag);
        }
      },
      onError: (response, context, networkDetails) => {
        this.resetLoader(frag, loader);
        reject(new LoadError({
          type: ErrorTypes.NETWORK_ERROR,
          details: ErrorDetails.FRAG_LOAD_ERROR,
          fatal: false,
          frag,
          part,
          response,
          networkDetails
        }));
      },
      onAbort: (stats, context, networkDetails) => {
        this.resetLoader(frag, loader);
        reject(new LoadError({
          type: ErrorTypes.NETWORK_ERROR,
          details: ErrorDetails.INTERNAL_ABORTED,
          fatal: false,
          frag,
          part,
          networkDetails
        }));
      },
      onTimeout: (response, context, networkDetails) => {
        this.resetLoader(frag, loader);
        reject(new LoadError({
          type: ErrorTypes.NETWORK_ERROR,
          details: ErrorDetails.FRAG_LOAD_TIMEOUT,
          fatal: false,
          frag,
          part,
          networkDetails
        }));
      }
    });
  }

  private resetLoader (frag: Fragment, loader: Loader<FragmentLoaderContext>) {
    this.updateLiveFragment = null;
    this.nextPartIndex = -1;
    frag.loader = null;
    if (this.loader === loader) {
      self.clearTimeout(this.partLoadTimeout);
      this.loader = null;
    }
  }
}

function createLoaderContext (frag: Fragment, part: Part | null = null): FragmentLoaderContext {
  const segment: BaseSegment = part || frag;
  const loaderContext: FragmentLoaderContext = {
    frag,
    part,
    responseType: 'arraybuffer',
    url: segment.url,
    rangeStart: 0,
    rangeEnd: 0
  };
  const start = segment.byteRangeStartOffset;
  const end = segment.byteRangeEndOffset;
  if (Number.isFinite(start) && Number.isFinite(end)) {
    loaderContext.rangeStart = start;
    loaderContext.rangeEnd = end;
  }
  return loaderContext;
}

export class LoadError extends Error {
  public readonly data: FragLoadFailResult;
  constructor (data: FragLoadFailResult, ...params) {
    super(...params);
    this.data = data;
  }
}

export interface FragLoadSuccessResult {
  payload: ArrayBuffer
  networkDetails: any
}

export interface FragLoadFailResult {
  type: string
  details: string
  fatal: boolean
  frag: Fragment
  part?: Part
  response?: {
    // error status code
    code: number,
    // error description
    text: string,
  }
  networkDetails: any
}

export type FragmentLoadProgressCallback = (result: FragLoadSuccessResult) => void;