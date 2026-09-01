import { useEffect, useRef, useState, useCallback } from 'react';
import { store, useApp } from '../store';
import { acceptCall, rejectCall, endCall, sendCallOffer, sendCallAnswer, sendCallIceCandidate } from '../socket';
import { consumePendingCallOffer } from '../useMessengerSocket';
import { Avatar } from './Avatar';
import {
  PhoneIcon,
  VideoIcon,
  MicIcon,
  MicOffIcon,
  VideoOffIcon,
  VolumeIcon,
  VolumeOffIcon,
  ScreenShareIcon,
  ScreenShareStopIcon,
  CameraSwitchIcon,
} from './icons';
import { formatCallDuration } from '../utils';
import { t } from '../i18n';
import { startCallTone } from '../sound';

const TURN_URL = (import.meta as any).env?.VITE_TURN_URL ?? '';
const TURN_USERNAME = (import.meta as any).env?.VITE_TURN_USERNAME ?? '';
const TURN_CREDENTIAL = (import.meta as any).env?.VITE_TURN_CREDENTIAL ?? '';

const STUN_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    ...(TURN_URL ? [{ urls: TURN_URL.split(','), username: TURN_USERNAME, credential: TURN_CREDENTIAL }] : []),
  ],
};

export function CallWindow() {
  const { activeCall, me } = useApp();
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const pendingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [volume, setVolume] = useState(1);
  const [mutedVolume, setMutedVolume] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [hasCamera, setHasCamera] = useState(false);
  const [cameraDeviceIds, setCameraDeviceIds] = useState<string[]>([]);
  const [callFailed, setCallFailed] = useState<string | null>(null);

  const callId = activeCall?.callId ?? null;
  const isOutgoing = activeCall?.direction === 'outgoing';
  const isIncoming = activeCall?.direction === 'incoming';
  const callType = activeCall?.callType ?? 'audio';
  const callerName = activeCall?.callerName ?? '';
  const status = activeCall?.status ?? 'ended';
  const toneRef = useRef<(() => void) | null>(null);

  // Play ringing/dial tone while the call is ringing or connecting
  useEffect(() => {
    const shouldRing = status === 'ringing' || status === 'connecting';
    if (shouldRing && !toneRef.current) {
      toneRef.current = startCallTone(isIncoming ? 'incoming' : 'outgoing');
    } else if (!shouldRing && toneRef.current) {
      toneRef.current();
      toneRef.current = null;
    }
  }, [status, isIncoming]);

  // Find peer from chat
  const chat = activeCall
    ? useApp().chats.find((c) => c.chat.id === activeCall.chatId)
    : null;
  const peer = chat?.peer ?? null;

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
    toneRef.current?.();
    toneRef.current = null;
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((tr) => tr.stop());
      screenStreamRef.current = null;
    }
    cameraTrackRef.current = null;
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((tr) => tr.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch { /* ignore */ }
      pcRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setElapsed(0);
    setMuted(false);
    setVideoOff(false);
    setVolume(1);
    setMutedVolume(false);
    setSharing(false);
  }, []);

  // Start local media
  const startLocalMedia = useCallback(async (withVideo: boolean) => {
    try {
      const constraints: MediaStreamConstraints = {
        audio: true,
        video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;
      cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      if (withVideo && navigator.mediaDevices?.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId).map((d) => d.deviceId);
          setCameraDeviceIds(cams);
          setHasCamera(cams.length > 0 || Boolean(stream.getVideoTracks()[0]));
        } catch { /* ignore */ }
      }
      return stream;
    } catch {
      return null;
    }
  }, []);

  // Create RTCPeerConnection
  const createPeer = useCallback((stream: MediaStream) => {
    const pc = new RTCPeerConnection(STUN_SERVERS);
    pcRef.current = pc;

    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });

    pc.onicecandidate = (e) => {
      if (e.candidate && callId) {
        sendCallIceCandidate(callId, e.candidate.toJSON());
      }
    };

    pc.ontrack = (e) => {
      if (remoteVideoRef.current && e.streams[0]) {
        remoteVideoRef.current.srcObject = e.streams[0];
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        const current = store.get().activeCall;
        store.set({ activeCall: current ? { ...current, status: 'connected' } : null });
        if (!timerRef.current) {
          timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
        }
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = undefined;
        }
      }
    };

    return pc;
  }, [callId]);

  // Handle incoming call: accept and create answer
  useEffect(() => {
    if (!isIncoming || !callId || status !== 'ringing') return;
    // Wait for user to click accept
  }, [isIncoming, callId, status]);

  // Handle call accepted (outgoing): create offer
  useEffect(() => {
    if (!callId || !isOutgoing || !activeCall) return;

    let cancelled = false;

    const setup = async () => {
      const stream = await startLocalMedia(callType === 'video');
      if (cancelled || !stream) {
        if (!cancelled) endCall(callId);
        return;
      }

      const pc = createPeer(stream);
      if (cancelled) return;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendCallOffer(callId, pc.localDescription!.toJSON());
    };

    void setup();

    return () => { cancelled = true; };
  }, [callId, isOutgoing, callType, startLocalMedia, createPeer, activeCall]);

  const flushPendingIce = useCallback(() => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    const pending = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const cand of pending) {
      try {
        void pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      } catch { /* ignore */ }
    }
  }, []);

  // Recover an offer that arrived before this window mounted (see
  // consumePendingCallOffer). Without this, a fast offer is lost and the call
  // stays at "Connecting" forever.
  useEffect(() => {
    if (!callId) return;
    const sdp = consumePendingCallOffer(callId);
    if (!sdp) return;
    const st = store.get();
    if (st.activeCall?.direction === 'incoming' && st.activeCall.status === 'ringing') {
      pendingOfferRef.current = sdp;
    } else {
      void (async () => {
        let stream = localStreamRef.current;
        if (!stream) stream = await startLocalMedia(callType === 'video');
        if (!stream) return;
        const pc = createPeer(stream);
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        flushPendingIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendCallAnswer(callId, pc.localDescription!.toJSON());
      })();
    }
  }, [callId, callType, startLocalMedia, createPeer, flushPendingIce]);

  // Handle WebRTC offer (incoming call)
  useEffect(() => {
    const onOffer = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.callId !== callId) return;

      // If this is an incoming call the user hasn't accepted yet, don't
      // auto-answer or grab the camera/mic. Buffer the offer and process it
      // only after the user clicks Accept (see handleAccept).
      const st = store.get();
      if (st.activeCall?.direction === 'incoming' && st.activeCall.status === 'ringing') {
        pendingOfferRef.current = detail.sdp as RTCSessionDescriptionInit;
        return;
      }

      await processOffer(detail.sdp as RTCSessionDescriptionInit);
    };

    const processOffer = async (sdp: RTCSessionDescriptionInit) => {
      // Reuse the media stream already acquired by handleAccept if present,
      // otherwise request it now (avoids requesting permission twice).
      let stream = localStreamRef.current;
      if (!stream) {
        stream = await startLocalMedia(callType === 'video');
        if (!stream) return;
      }

      const pc = createPeer(stream);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendCallAnswer(callId!, pc.localDescription!.toJSON());
    };

    window.addEventListener('webrtc:offer', onOffer);
    return () => window.removeEventListener('webrtc:offer', onOffer);
  }, [callId, callType, startLocalMedia, createPeer, flushPendingIce]);

  // Handle WebRTC answer
  useEffect(() => {
    const onAnswer = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.callId !== callId) return;
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(detail.sdp));
        flushPendingIce();
      }
    };

    window.addEventListener('webrtc:answer', onAnswer);
    return () => window.removeEventListener('webrtc:answer', onAnswer);
  }, [callId, flushPendingIce]);

  // Handle ICE candidates
  useEffect(() => {
    const onIce = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.callId !== callId) return;
      const pc = pcRef.current;
      if (!pc) {
        // PC not created yet — the event arrived before the offer/answer was
        // processed. Buffer it and flush once the remote description is set.
        pendingIceRef.current.push(detail.candidate as RTCIceCandidateInit);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(detail.candidate));
      } catch {
        // Remote description may not be set yet at the time a candidate lands.
        // Buffer and retry later rather than silently dropping the candidate.
        pendingIceRef.current.push(detail.candidate as RTCIceCandidateInit);
      }
    };

    window.addEventListener('webrtc:ice-candidate', onIce);
    return () => window.removeEventListener('webrtc:ice-candidate', onIce);
  }, [callId]);

  // Handle call end from remote
  useEffect(() => {
    const onEnded = () => {
      cleanup();
    };
    window.addEventListener('webrtc:ended', onEnded);
    return () => window.removeEventListener('webrtc:ended', onEnded);
  }, [cleanup]);

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  // Harden the call against hanging at "Connecting…" forever. If media cannot
  // establish (no TURN behind a strict NAT), give up with a clear message.
  useEffect(() => {
    if (!callId) return;
    setCallFailed(null);
  }, [callId]);

  useEffect(() => {
    if (status !== 'connecting') return;
    const tm = setTimeout(() => {
      setCallFailed(t('Could not establish the call connection. Your network may block it (a relay/TURN server is required).'));
    }, 30_000);
    return () => clearTimeout(tm);
  }, [status, callId]);

  useEffect(() => {
    if (status === 'connected') setCallFailed(null);
  }, [status]);

  // Handle accept button
  const handleAccept = async () => {
    if (!callId) return;
    acceptCall(callId);
    store.set({ activeCall: activeCall ? { ...activeCall, status: 'connecting' } : null });
    // Start local media and wait for the (buffered) offer
    const stream = await startLocalMedia(callType === 'video');
    if (!stream) {
      endCall(callId);
      cleanup();
      return;
    }
    // If the offer already arrived while the call was ringing, answer it now.
    const buffered = pendingOfferRef.current;
    if (buffered) {
      pendingOfferRef.current = null;
      const pc = createPeer(stream);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(buffered));
        flushPendingIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendCallAnswer(callId, pc.localDescription!.toJSON());
      } catch (err) {
        console.error('Answer failed', err);
        endCall(callId);
        cleanup();
      }
    }
  };

  // Handle reject button
  const handleReject = () => {
    if (!callId) return;
    rejectCall(callId);
    cleanup();
    store.set({ activeCall: null });
  };

  // Handle end button
  const handleEnd = () => {
    if (!callId) return;
    endCall(callId);
    cleanup();
    store.set({ activeCall: null });
  };

  // Toggle microphone mute
  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setMuted(!audioTrack.enabled);
      }
    }
  };

  // Toggle video
  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setVideoOff(!videoTrack.enabled);
      }
    }
  };

  // Volume control
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (remoteVideoRef.current) remoteVideoRef.current.volume = v;
    setMutedVolume(v === 0);
  };

  const toggleSpeaker = () => {
    const newMuted = !mutedVolume;
    setMutedVolume(newMuted);
    if (remoteVideoRef.current) remoteVideoRef.current.volume = newMuted ? 0 : volume;
  };

  // ---- Screen sharing ----
  const stopScreenShare = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((tr) => tr.stop());
      screenStreamRef.current = null;
    }
    const pc = pcRef.current;
    const cameraTrack = cameraTrackRef.current ?? localStreamRef.current?.getVideoTracks()[0] ?? null;
    if (pc && callType === 'video' && cameraTrack) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) void sender.replaceTrack(cameraTrack).catch(() => {});
    }
    if (cameraTrack) cameraTrack.enabled = !videoOff;
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    setSharing(false);
  }, [callType, videoOff]);

  const startScreenShare = async () => {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = displayStream;
      const screenTrack = displayStream.getVideoTracks()[0];
      if (!screenTrack) return;

      // Pause the local camera while the screen is shared
      const cameraTrack = cameraTrackRef.current ?? localStreamRef.current?.getVideoTracks()[0] ?? null;
      if (cameraTrack) cameraTrack.enabled = false;

      const pc = pcRef.current;
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(screenTrack);
      }

      // Show what is being shared in the local preview
      if (localVideoRef.current) localVideoRef.current.srcObject = displayStream;
      setSharing(true);

      screenTrack.addEventListener('ended', () => {
        stopScreenShare();
      });
    } catch { /* user cancelled the picker */ }
  };

  // ---- Camera switch (front/back or multiple webcams) ----
  const switchCamera = async () => {
    if (sharing) return;
    const stream = localStreamRef.current;
    if (!stream) return;
    const current = cameraTrackRef.current ?? stream.getVideoTracks()[0];
    if (!current) return;
    try {
      const facing = current.getSettings().facingMode;
      const useDeviceId = cameraDeviceIds.length >= 2
        ? (() => {
            const idx = cameraDeviceIds.indexOf(current.getSettings().deviceId ?? '');
            return cameraDeviceIds[(idx + 1 + cameraDeviceIds.length) % cameraDeviceIds.length];
          })()
        : undefined;
      const videoConstraints: MediaTrackConstraints = useDeviceId
        ? { deviceId: { exact: useDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: facing === 'user' ? 'environment' : 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
      const newStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) {
        newStream.getTracks().forEach((tr) => tr.stop());
        return;
      }

      const pc = pcRef.current;
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newTrack);
      }
      newTrack.enabled = !videoOff;
      stream.removeTrack(current);
      stream.addTrack(newTrack);
      current.stop();
      cameraTrackRef.current = newTrack;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    } catch { /* permission denied or no other camera */ }
  };

  if (!activeCall || !callId) return null;

  const peerAvatar = peer ?? { id: 0, first_name: callerName.split(' ')[0] ?? '', last_name: callerName.split(' ').slice(1).join(' ') ?? '', photo: null };

  return (
    <div className="call-window">
      <div className="call-bg">
        <Avatar user={peerAvatar} size={128} />
      </div>

      <div className="call-info">
        <Avatar user={peerAvatar} size={80} />
        <b className="call-name">{callerName || t('Unknown')}</b>
        {status === 'ringing' && <span className="call-status">{t('Calling…')}</span>}
        {status === 'connecting' && <span className="call-status">{t('Connecting…')}</span>}
        {status === 'connected' && <span className="call-status">{formatCallDuration(elapsed)}</span>}
      </div>

      {callFailed && <div className="call-failed">{callFailed}</div>}

      <div className="call-videos">
        {callType === 'video' && (
          <>
            <video ref={remoteVideoRef} className="call-video-remote" autoPlay playsInline />
            <video ref={localVideoRef} className="call-video-local" autoPlay playsInline muted />
          </>
        )}
        {callType === 'audio' && (
          <>
            <audio ref={remoteVideoRef} autoPlay playsInline />
            <video ref={localVideoRef} className="call-video-local hidden" autoPlay playsInline muted />
          </>
        )}
      </div>

      <div className="call-controls">
        {isIncoming && status === 'ringing' ? (
          <>
            <button className="call-btn call-btn-reject" onClick={handleReject} title={t('Reject')}>
              <PhoneIcon size={24} />
            </button>
            <button className="call-btn call-btn-accept" onClick={handleAccept} title={t('Accept')}>
              <PhoneIcon size={24} />
            </button>
          </>
        ) : (
          <>
            <button
              className={`call-btn${muted ? ' call-btn-active' : ''}`}
              onClick={toggleMute}
              title={muted ? t('Unmute') : t('Mute')}
            >
              {muted ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
            </button>

            {callType === 'video' && (
              <button
                className={`call-btn${videoOff ? ' call-btn-active' : ''}`}
                onClick={toggleVideo}
                title={videoOff ? t('Turn camera on') : t('Turn camera off')}
              >
                {videoOff ? <VideoOffIcon size={20} /> : <VideoIcon size={20} />}
              </button>
            )}

            {callType === 'video' && hasCamera && (
              <button
                className="call-btn"
                onClick={switchCamera}
                title={t('Switch camera')}
              >
                <CameraSwitchIcon size={20} />
              </button>
            )}

            {callType === 'video' && status === 'connected' && (
              <button
                className={`call-btn${sharing ? ' call-btn-active call-btn-danger' : ''}`}
                onClick={sharing ? stopScreenShare : startScreenShare}
                title={sharing ? t('Stop sharing') : t('Share screen')}
              >
                {sharing ? <ScreenShareStopIcon size={20} /> : <ScreenShareIcon size={20} />}
              </button>
            )}

            <button
              className="call-btn call-btn-end"
              onClick={handleEnd}
              title={t('End call')}
            >
              <PhoneIcon size={24} />
            </button>

            <button
              className={`call-btn${mutedVolume ? ' call-btn-active' : ''}`}
              onClick={toggleSpeaker}
              title={mutedVolume ? t('Unmute speaker') : t('Mute speaker')}
            >
              {mutedVolume ? <VolumeOffIcon size={20} /> : <VolumeIcon size={20} />}
            </button>

            <input
              type="range"
              className="call-volume-slider"
              min="0"
              max="1"
              step="0.05"
              value={mutedVolume ? 0 : volume}
              onChange={handleVolumeChange}
              title={t('Volume')}
            />
          </>
        )}
      </div>
    </div>
  );
}
