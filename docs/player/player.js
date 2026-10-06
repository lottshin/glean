(function () {
	'use strict';

	var SOURCE = 'glean-youtube-bridge';
	var HOST_SOURCE = 'glean-youtube-host';
	var player = null;
	var videoId = '';
	var segment = null;
	var frame = null;

	// Standalone ?v=<id> opens this page directly in a browser for a smoke test.
	// The embedded (host) flow never uses it: the Obsidian side sends the video
	// id through postMessage after 'ready'.
	var testVideoId = new URLSearchParams(window.location.search).get('v') || '';
	var standalone = window.self === window.top;

	// The player area shows nothing but an endless spinner when a video stalls,
	// so surface player states in a tiny on-page chip for remote debugging.
	var statusChip = null;
	var lastStatusText = '';
	var netText = '';
	function showStatus(text) {
		lastStatusText = text;
		if (statusChip === null) {
			statusChip = document.createElement('div');
			statusChip.style.cssText =
				'position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;' +
				'background:rgba(0,0,0,.6);color:#eee;font:11px/1.4 -apple-system,Helvetica,sans-serif;' +
				'padding:3px 9px;border-radius:9px;';
			document.body.appendChild(statusChip);
		}
		statusChip.textContent = 'Glean bridge · ' + text + (netText ? ' · ' + netText : '');
	}
	function hideStatus() {
		if (statusChip !== null) statusChip.remove();
		statusChip = null;
	}
	var STATE_TEXT = { '-1': '未开始', '0': '已结束', '2': '已暂停', '3': '缓冲中…', '5': '已就绪' };

	// Reachability probes: the player shell comes from youtube.com while the
	// video bytes come from googlevideo.com. A rule-based VPN can pass the
	// first and silently black-hole the second; the chip makes that visible.
	var PROBES = [
		['yt', 'https://www.youtube.com/generate_204'],
		['gvideo', 'https://redirector.googlevideo.com/generate_204'],
	];
	function probeUrl(url, timeoutMs) {
		return new Promise(function (resolve) {
			var settled = false;
			var timer = setTimeout(function () {
				if (!settled) { settled = true; resolve(false); }
			}, timeoutMs);
			fetch(url, { mode: 'no-cors', cache: 'no-store' })
				.then(function () {
					if (!settled) { settled = true; clearTimeout(timer); resolve(true); }
				})
				.catch(function () {
					if (!settled) { settled = true; clearTimeout(timer); resolve(false); }
				});
		});
	}
	function runNetProbes() {
		Promise.all(PROBES.map(function (item) {
			return probeUrl(item[1], 8000).then(function (ok) { return item[0] + (ok ? '✓' : '✗'); });
		})).then(function (parts) {
			netText = parts.join(' ');
			if (statusChip !== null) showStatus(lastStatusText);
		});
	}

	var fractionTimer = null;
	function startFractionMonitor() {
		stopFractionMonitor();
		fractionTimer = setInterval(function () {
			if (player && typeof player.getVideoLoadedFraction === 'function') {
				showStatus(
					'缓冲中… ' + Math.round(player.getVideoLoadedFraction() * 100) + '% · 时长 ' +
					Math.round(player.getDuration() || 0) + 's',
				);
			}
		}, 1000);
	}
	function stopFractionMonitor() {
		if (fractionTimer !== null) {
			clearInterval(fractionTimer);
			fractionTimer = null;
		}
	}

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
			// Regular youtube.com host (not youtube-nocookie.com): the nocookie
			// host never writes cookies, so YouTube's "confirm you're not a bot"
			// gate can never clear in cookie-capable webviews.
			host: 'https://www.youtube.com',
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
				onReady: function () {
					send('ready');
					if (/^[A-Za-z0-9_-]{11}$/.test(testVideoId)) {
						videoId = testVideoId;
						showStatus('加载视频 ' + testVideoId);
						player.cueVideoById({ videoId: testVideoId, startSeconds: 0 });
					} else {
						showStatus('就绪，等待视频');
					}
				},
				onStateChange: function (event) {
					send('state', { state: event.data });
					if (event.data === 1) {
						hideStatus();
						stopFractionMonitor();
						startMonitor();
					} else {
						stopFractionMonitor();
						if (STATE_TEXT[String(event.data)]) showStatus(STATE_TEXT[String(event.data)]);
						if (event.data === 3) startFractionMonitor();
					}
					if (event.data === 2) stopMonitor();
					if (event.data === 0) finishSegment();
				},
				onError: function (event) {
					send('error', { code: event.data });
					showStatus('错误 ' + event.data);
				},
			},
		});
	}

	function loadApi() {
		showStatus('加载播放器 API…');
		runNetProbes();
		setInterval(runNetProbes, 15000);
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
				showStatus('收到视频 ' + videoId);
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

	if (standalone && !/^[A-Za-z0-9_-]{11}$/.test(testVideoId)) {
		// A bare visit has no host to send a video id, so the empty YouTube
		// embed would only show a generic playback error. Say what to do.
		document.getElementById('player').textContent =
			'Glean YouTube player bridge. Append ?v=VIDEO_ID (11 characters) to test playback here.';
		return;
	}

	window.setInterval(sendTime, 100);
	loadApi();
}());
