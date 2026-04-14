/**
 * Minimal reproduction of the use-after-dispose race described in the audit:
 *
 *   Synth.trigger (synthutils.js ~1735-1743) is async and awaits
 *   `Tone.ToneAudioBuffer.loaded()` BEFORE calling
 *   `synth.triggerAttackRelease(...)`.
 *
 *   Logo.doStopTurtles (logo.js:1055) calls
 *   `this.synth.disposeAllInstruments()` synchronously on stop, which
 *   disposes and DELETES every instrument from the `instruments` map.
 *
 * Because `trigger` captures the `synth` reference at entry and resumes on a
 * microtask after the await, the synth it uses may already be disposed (and
 * removed from the `instruments` map) by the time `triggerAttackRelease` is
 * invoked.
 *
 * This test is a faithful structural reduction of those two code paths. It
 * does NOT instantiate Tone.js (that is brittle under jsdom); it models the
 * exact lifecycle contract: a synth object with dispose() flipping a
 * `.disposed` flag, an awaitable "buffer loaded" promise, and the same
 * "delete instruments[turtle][name]" shape. The ordering is the one that
 * happens in production when a student presses Stop mid-note.
 */

describe("Use-after-dispose race in Synth.trigger async path", () => {
    // ── Helpers that mirror the production shapes ───────────────────────────
    function makeSynth(name) {
        return {
            name,
            disposed: false,
            triggers: [], // record every triggerAttackRelease call
            dispose() {
                this.disposed = true;
            },
            triggerAttackRelease(notes, beat, when) {
                // In Tone.js, calling this on a disposed node throws or is
                // silently dropped into a dead audio graph. Record both the
                // call and whether we were disposed at call time.
                this.triggers.push({
                    notes,
                    beat,
                    when,
                    calledAfterDispose: this.disposed
                });
            }
        };
    }

    // Faithful model of Synth.disposeAllInstruments (synthutils.js:3555)
    function disposeAllInstruments(instruments) {
        for (const turtle in instruments) {
            for (const name in instruments[turtle]) {
                const s = instruments[turtle][name];
                if (s && typeof s.dispose === "function") {
                    try {
                        s.dispose();
                    } catch (e) {
                        /* swallowed in prod */
                    }
                }
                delete instruments[turtle][name];
            }
        }
    }

    // Faithful model of Synth.trigger's await-then-fire path
    // (synthutils.js:1735-1743). The bug: `synth` is captured at entry and
    // used after the await with no liveness check.
    async function trigger(instruments, turtle, name, notes, beat, bufferLoaded) {
        const synth = instruments[turtle][name]; // capture at entry
        try {
            await bufferLoaded; // microtask boundary
            synth.triggerAttackRelease(notes, beat, /*when*/ 0);
        } catch (e) {
            // Prod code swallows with console.debug → silent failure.
        }
    }

    test("BUG: triggerAttackRelease fires on a disposed synth after stop", async () => {
        // Arrange: one turtle, one instrument (matches prepSynths shape).
        const instruments = { 0: { "electronic synth": makeSynth("electronic synth") } };
        const synthRef = instruments[0]["electronic synth"];

        // A controllable "buffer loaded" await — Tone.ToneAudioBuffer.loaded()
        // resolves on a microtask after all samples decode. On classroom
        // Chromebooks/iPads this can be tens to hundreds of ms on first hit.
        let resolveBuffer;
        const bufferLoaded = new Promise(r => {
            resolveBuffer = r;
        });

        // Act 1: student presses Play → a note begins triggering and parks on
        // the await.
        const pending = trigger(instruments, 0, "electronic synth", "C4", 0.25, bufferLoaded);

        // Act 2: student presses Stop mid-decode. doStopTurtles runs
        // disposeAllInstruments SYNCHRONOUSLY.
        disposeAllInstruments(instruments);

        // Sanity: stop did its job — instrument is gone from the map and
        // marked disposed.
        expect(instruments[0]["electronic synth"]).toBeUndefined();
        expect(synthRef.disposed).toBe(true);

        // Act 3: buffer decode finally completes, trigger resumes.
        resolveBuffer();
        await pending;

        // Assert: the bug. The captured reference was used AFTER dispose.
        expect(synthRef.triggers).toHaveLength(1);
        expect(synthRef.triggers[0].calledAfterDispose).toBe(true);
    });

    test("BUG: stale trigger lands on NEW instrument created by next run (phantom note)", async () => {
        // Models _doFastButton: stop → 500ms → runLogoCommands → prepSynths
        // rebuilds instruments under the SAME key. A stale awaiting trigger
        // from the previous run will resume and fire against whatever synth
        // currently occupies instruments[turtle][name] — which may be the
        // new run's freshly created instrument.
        //
        // Note: the production `trigger` captures `synth` at entry, so the
        // stale trigger fires on the OLD (disposed) synth. But the graph-
        // rewire branch (synthutils.js:1745+) re-reads effect nodes via
        // `instruments[turtle][name]` lookups after await — those lookups
        // see the NEW instrument. This test models that lookup-after-await
        // shape to show it is reachable.

        const instruments = { 0: { "electronic synth": makeSynth("OLD") } };
        let resolveBuffer;
        const bufferLoaded = new Promise(r => {
            resolveBuffer = r;
        });

        // Same shape as the rewire path: re-lookup after await.
        async function triggerWithRelookup() {
            try {
                await bufferLoaded;
                const liveSynth = instruments[0]?.["electronic synth"];
                if (liveSynth) liveSynth.triggerAttackRelease("C4", 0.25, 0);
            } catch (_) {
                /* swallowed */
            }
        }

        const pending = triggerWithRelookup();

        // Stop: dispose everything.
        disposeAllInstruments(instruments);

        // 500 ms later, prepSynths rebuilds the instrument under the same key.
        const NEW = makeSynth("NEW");
        instruments[0]["electronic synth"] = NEW;

        // Now the parked await resumes.
        resolveBuffer();
        await pending;

        // Phantom note: the NEW run's instrument fired a note that the new
        // run's block stream never requested.
        expect(NEW.triggers).toHaveLength(1);
        expect(NEW.triggers[0].notes).toBe("C4");
    });

    test("PROPOSED FIX: epoch check after await suppresses the stale trigger", async () => {
        // Sketch of minimal fix #2 from the audit: an _instrumentEpoch
        // incremented by disposeAllInstruments, captured by trigger at entry
        // and re-checked after each await.
        const state = {
            instruments: { 0: { "electronic synth": makeSynth("E1") } },
            epoch: 0
        };

        function disposeAllWithEpoch() {
            state.epoch++;
            for (const t in state.instruments) {
                for (const n in state.instruments[t]) {
                    state.instruments[t][n].dispose();
                    delete state.instruments[t][n];
                }
            }
        }

        let resolveBuffer;
        const bufferLoaded = new Promise(r => {
            resolveBuffer = r;
        });

        async function safeTrigger() {
            const synth = state.instruments[0]["electronic synth"];
            const epoch = state.epoch;
            try {
                await bufferLoaded;
                if (state.epoch !== epoch) return; // bail: stop happened
                if (synth.disposed) return; // belt-and-braces
                synth.triggerAttackRelease("C4", 0.25, 0);
            } catch (_e) {
                // swallowed in production (console.debug); suppress here too
            }
        }

        const synthRef = state.instruments[0]["electronic synth"];
        const pending = safeTrigger();
        disposeAllWithEpoch();
        resolveBuffer();
        await pending;

        // Fix holds: no call was made on the disposed synth.
        expect(synthRef.triggers).toHaveLength(0);
        expect(synthRef.disposed).toBe(true);
    });
});
