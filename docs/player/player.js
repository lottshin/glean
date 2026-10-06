(function () {
	'use strict';

	var SOURCE = 'glean-youtube-bridge';
	var HOST_SOURCE = 'glean-youtube-host';
	var player = null;
	var videoId = '';
	var segment = null;
	var frame = null;

	function send(type, payload) {
		window.parent.postMessage(Object.assign({ source: SOURCE, type: type }, payload || {}), '*');
	}

	function stopMonitor() {
		if (frame !== null) {
			window.cancelAnimationFrame(frame);
			frame = null;
		}
	}

	function finishSegment() {
		if (!segment) return;
		segment = null;
		stopMonitor();
		send('segment-end');
	}

	function monitorSegment() {
		frame = null;
		if (!segment || !player) return;
		if (player.getCurrentTime() >= segment.end) {
			player.pauseVideo();
			finishSegment();
			return;
		}
		frame = window.requestAnimationFrame(monitorSegment);
	}

	function startMonitor() {
		if (frame === null && segment) frame = window.requestAnimationFrame(monitorSegment);
	}

	function sendTime() {
		if (!player || typeof player.getCurrentTime !== 'function') return;
		send('time', {
			time: player.getCurrentTime(),
			duration: player.getDuration(),
		});
	}

	function createPlayer() {
		player = new window.YT.Player('player', {
			host: 'https://www.youtube-nocookie.com',
			playerVars: {
				autoplay: 0,
				controls: 1,
				enablejsapi: 1,
				playsinline: 1,
				rel: 0,
				origin: window.location.origin,
				widget_referrer: window.location.origin,
			},
			events: {
				onReady: function () { send('ready'); },
				onStateChange: function (event) {
					send('state', { state: event.data });
					if (event.data === 1) startMonitor();
					if (event.data === 2) stopMonitor();
					if (event.data === 0) finishSegment();
				},
				onError: function (event) { send('error', { code: event.data }); },
			},
		});
	}

	function loadApi() {
		if (window.YT && window.YT.Player) {
			createPlayer();
			return;
		}
		window.onYouTubeIframeAPIReady = createPlayer;
		var script = document.createElement('script');
		script.src = 'https://www.youtube.com/iframe_api';
		script.async = true;
		document.head.appendChild(script);
	}

	window.addEventListener('message', function (event) {
		if (event.source !== window.parent || !event.data || event.data.source !== HOST_SOURCE || !player) return;
		var data = event.data;
		switch (data.type) {
			case 'load':
				videoId = data.videoId || '';
				segment = null;
				stopMonitor();
				player.cueVideoById({ videoId: videoId, startSeconds: 0 });
				break;
			case 'play':
				player.playVideo();
				break;
			case 'pause':
				player.pauseVideo();
				break;
			case 'seek':
				segment = null;
				stopMonitor();
				player.seekTo(Math.max(0, Number(data.seconds) || 0), true);
				break;
			case 'rate':
				player.setPlaybackRate(Number(data.rate) || 1);
				break;
			case 'segment':
				if (!(Number(data.end) > Number(data.start)) || !videoId) break;
				segment = { start: Number(data.start), end: Number(data.end) };
				player.loadVideoById({
					videoId: videoId,
					startSeconds: Math.max(0, segment.start),
					endSeconds: segment.end,
				});
				startMonitor();
				break;
			case 'cancel-segment':
				segment = null;
				stopMonitor();
				player.seekTo(player.getCurrentTime(), true);
				break;
		}
	});

	window.setInterval(sendTime, 100);
	loadApi();
}());
