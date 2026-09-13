import React from 'react';
import {Composition} from 'remotion';
import {Reel} from './Reel.jsx';

export function Root() {
  return <Composition id="Reel" component={Reel} width={1080} height={1920} fps={30} durationInFrames={900} defaultProps={{sourceVideo: '/media/source.mp4'}} />;
}
