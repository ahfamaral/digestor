"use client";

import { createContext, useContext } from "react";

/**
 * Whether the session has a picture, for copy deep in shared components (Who's who, the name popover) that would
 * otherwise say "video" about an audio file. Screens of an audio-only session provide `false`; the default is true.
 */
const HasVideoContext = createContext(true);

export const HasVideoProvider = HasVideoContext.Provider;
export const useHasVideo = (): boolean => useContext(HasVideoContext);
