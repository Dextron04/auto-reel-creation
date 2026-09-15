import React from 'react';
import {AbsoluteFill, Audio, OffthreadVideo, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {getActiveWordColor} from './dialogue.mjs';
import {sceneMotion} from './scene-registry.mjs';

function Caption({caption}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const absoluteTime = caption.start + frame / fps;

  return <div style={{position: 'absolute', left: 70, right: 70, top: 860, textAlign: 'center', fontFamily: 'Arial, Helvetica, sans-serif', fontWeight: 900, fontSize: 64, lineHeight: 1.08, letterSpacing: '-1.5px', color: '#fff', WebkitTextStroke: '8px #000', paintOrder: 'stroke fill', textShadow: '0 5px 0 #000'}}>{caption.tokens?.map((token) => {
    const isActive = absoluteTime >= token.start && absoluteTime < token.end;
    return <span key={`${token.text}-${token.start}`} style={{color: isActive ? getActiveWordColor(caption.speaker) : '#fff'}}>{token.text} </span>;
  }) ?? caption.text}</div>;
}

function VisualBeat({visual}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const duration = Math.max(2,Math.ceil((visual.end-visual.start)*fps));
  const edge = Math.min(6,duration/3);
  return <div style={{position:'absolute',left:110,right:110,top:140,height:650,display:'flex',justifyContent:'center',alignItems:'center',
    opacity:interpolate(frame,[0,edge,duration-edge,duration],[0,1,1,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'}),
    ...sceneMotion(visual, frame, fps),
    translate:`0px ${interpolate(frame,[0,edge],[18,0],{extrapolateRight:'clamp'})}px`}}>
    <Img src={visual.imagePath} style={{maxWidth:'100%',maxHeight:'100%',width:visual.kind==='logo'?420:undefined,objectFit:'contain',borderRadius:16}} />
  </div>;
}

function SpeakerCharacter({segment}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const duration = Math.max(2, Math.ceil((segment.end - segment.start) * fps));
  const enter = Math.min(7, duration / 3);
  const isPeter = segment.speaker === 'peter';
  return <div style={{position: 'absolute', left: isPeter ? undefined : 70, right: isPeter ? 55 : undefined, bottom: -14, width: isPeter ? 440 : 350, height: isPeter ? 700 : 520, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', opacity: interpolate(frame, [0, enter, duration - enter, duration], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}), translate: `${(isPeter ? 1 : -1) * interpolate(frame, [0, enter], [34, 0], {extrapolateRight: 'clamp'})}px 0px`, scale: interpolate(frame, [0, enter, duration], [0.92, 1, 1.025], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>
    <Img src={segment.imagePath} style={{maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', filter: 'drop-shadow(0 14px 16px rgba(0,0,0,.42))'}} />
  </div>;
}

export function Reel({sourceVideo, voiceOverlay, audioSegments = [], characterSegments = [], pngOverlay, captions = [], visuals = [], startFrame = 0}) {
  const {fps} = useVideoConfig();
  const localUrl = (value) => value?.startsWith('/media/') ? `http://localhost:3001${value}` : value;
  return <AbsoluteFill style={{backgroundColor: '#000'}}>
    <OffthreadVideo src={localUrl(sourceVideo)} startFrom={startFrame} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
    <AbsoluteFill style={{background: 'linear-gradient(180deg, transparent 45%, rgba(0,0,0,.18) 100%)'}} />
    {pngOverlay ? <Img src={localUrl(pngOverlay)} style={{position: 'absolute', width: 420, right: 32, bottom: 240}} /> : null}
    {visuals.map((visual) => <Sequence key={`${visual.title}-${visual.start}`} from={Math.round(visual.start * fps)} durationInFrames={Math.max(1, Math.ceil((visual.end - visual.start) * fps))}><VisualBeat visual={{...visual, imagePath: localUrl(visual.imagePath)}} /></Sequence>)}
    {characterSegments.map((segment) => <Sequence key={`${segment.speaker}-${segment.start}`} from={Math.round(segment.start * fps)} durationInFrames={Math.max(1, Math.ceil((segment.end - segment.start) * fps))}><SpeakerCharacter segment={{...segment, imagePath: localUrl(segment.imagePath)}} /></Sequence>)}
    {captions.map((caption) => <Sequence key={`${caption.speaker}-${caption.start}-${caption.text}`} from={Math.round(caption.start * fps)} durationInFrames={Math.max(1, Math.ceil((caption.end - caption.start) * fps))}><Caption caption={caption} /></Sequence>)}
    {audioSegments.map((segment) => <Sequence key={`${segment.speaker}-${segment.start}`} from={Math.round(segment.start * fps)} durationInFrames={Math.max(1, Math.ceil((segment.end - segment.start) * fps))}><Audio src={localUrl(segment.audioPath)} playbackRate={segment.playbackRate} /></Sequence>)}
    {voiceOverlay ? <Audio src={localUrl(voiceOverlay)} /> : null}
  </AbsoluteFill>;
}
