/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

import {
  extractFuncsAndResourcesFromFrameLocations,
  processProfile,
  serializeProfile,
  unserializeProfileOfArbitraryFormat,
} from '../../profile-logic/process-profile';
import { UniqueStringArray } from '../../utils/unique-string-array';
import {
  createGeckoProfile,
  createGeckoCounter,
  createGeckoMarkerStack,
} from '../fixtures/profiles/gecko-profile';
import { ensureExists } from '../../utils/flow';
import type { JsAllocationPayload_Gecko } from '../../types/markers';
import type { GeckoThread } from '../../types/gecko-profile';

describe('extract functions and resource from location strings', function() {
  // These location strings are turned into the proper funcs.
  const locations = [
    // Extract unsymbolicated memory and match them to libraries.
    '0xc0ff33',
    '0xe0ff33',

    // Extract C++ function names and resources
    'cppFunction1 (in c++ resource name1) + 123',
    'cppFunction2 (in c++ resource name2) (234:345)',
    'cppFunction3 (in c++ resource name2)',

    // Extract JS functions URL information
    'jsFunction1 (http://script.com/one.js:456:1)',
    'http://script.com/one.js:456:1',

    // Extension locations
    'moz-extension://bf3bb73c-919c-4fef-95c4-070a19fdaf85/background.js:1:0',
    'moz-extension://fa2edf9c-c45f-4445-b819-c09e3f2d58d5/content.js:1:0',
    'backgroundFunction (moz-extension://bf3bb73c-919c-4fef-95c4-070a19fdaf85/background.js:2:1)',
    'contentfunction (moz-extension://fa2edf9c-c45f-4445-b819-c09e3f2d58d5/content.js:2:1)',

    // Something unknown
    'mysterious location',
  ];
  const libs = [
    // This library will match the '0xc0ff33' location.
    {
      start: 0xc00000,
      end: 0xd00000,
      offset: 0,
      arch: '',
      name: 'No symbols library',
      path: '',
      debugName: '',
      debugPath: '',
      breakpadId: '',
    },
    // This library will match the '0xe0ff33' location, and it has an offset.
    {
      start: 0xe01000,
      end: 0xf00000,
      offset: 0x1000,
      arch: '',
      name: 'No symbols library',
      path: '',
      debugName: '',
      debugPath: '',
      breakpadId: '',
    },
  ];
  const stringTable = new UniqueStringArray();
  const locationIndexes = locations.map(location =>
    stringTable.indexForString(location)
  );
  const extensions = {
    baseURL: [
      'moz-extension://bf3bb73c-919c-4fef-95c4-070a19fdaf85/',
      'moz-extension://fa2edf9c-c45f-4445-b819-c09e3f2d58d5/',
    ],
    id: ['geckoprofiler@mozilla.com', 'screenshots@mozilla.org'],
    name: ['Gecko Profiler', 'Firefox Screenshots'],
    length: 2,
  };

  it('extracts the information for all different types of locations', function() {
    const [
      funcTable,
      resourceTable,
      frameFuncs,
    ] = extractFuncsAndResourcesFromFrameLocations(
      locationIndexes,
      locationIndexes.map(() => false),
      stringTable,
      libs,
      extensions
    );

    expect(
      frameFuncs.map((funcIndex, locationIndex) => {
        // Map all the results into a human readable object for easy snapshotting.
        const locationName = locations[locationIndex];

        const funcName = stringTable.getString(funcTable.name[funcIndex]);
        const resourceIndex = funcTable.resource[funcIndex];
        const address = funcTable.address[funcIndex];
        const isJS = funcTable.isJS[funcIndex];
        const fileNameIndex = funcTable.fileName[funcIndex];
        const fileName =
          fileNameIndex === null ? null : stringTable.getString(fileNameIndex);
        const lineNumber = funcTable.lineNumber[funcIndex];
        const columnNumber = funcTable.columnNumber[funcIndex];

        let libIndex, resourceName, host, resourceType;
        if (resourceIndex === -1) {
          resourceName = null;
          host = null;
          resourceType = null;
        } else {
          const hostStringIndex = resourceTable.host[resourceIndex];
          libIndex = resourceTable.lib[resourceIndex];
          resourceName = stringTable.getString(
            resourceTable.name[resourceIndex]
          );
          host =
            hostStringIndex === undefined || hostStringIndex === null
              ? null
              : stringTable.getString(hostStringIndex);
          resourceType = resourceTable.type[resourceIndex];
        }
        const lib =
          libIndex === undefined || libIndex === null || libIndex === -1
            ? undefined
            : libs[libIndex];

        return [
          locationName,
          {
            funcName,
            isJS,
            resourceIndex,
            address,
            fileName,
            lineNumber,
            columnNumber,
            libIndex,
            resourceName,
            host,
            resourceType,
            lib,
          },
        ];
      })
    ).toMatchSnapshot();
  });
});

describe('gecko counters processing', function() {
  function setup() {
    // Create a gecko profile with counters.
    const findMainThread = profile =>
      ensureExists(
        profile.threads.find(thread => thread.name === 'GeckoMain'),
        'There should be a GeckoMain thread in the Gecko profile'
      );

    const parentGeckoProfile = createGeckoProfile();
    const [childGeckoProfile] = parentGeckoProfile.processes;

    const parentPid = findMainThread(parentGeckoProfile).pid;
    const childPid = findMainThread(childGeckoProfile).pid;
    expect(parentPid).toEqual(3333);
    expect(childPid).toEqual(2222);

    const parentCounter = createGeckoCounter(
      findMainThread(parentGeckoProfile)
    );
    const childCounter = createGeckoCounter(findMainThread(childGeckoProfile));
    parentGeckoProfile.counters = [parentCounter];
    childGeckoProfile.counters = [childCounter];
    return {
      parentGeckoProfile,
      parentPid,
      childPid,
      parentCounter,
      childCounter,
    };
  }

  it('can extract the counter information correctly', function() {
    const { parentGeckoProfile, parentPid, childPid } = setup();
    const processedProfile = processProfile(parentGeckoProfile);
    const counters = ensureExists(
      processedProfile.counters,
      'Expected to find counters on the processed profile'
    );
    expect(counters.length).toBe(2);
    expect(counters[0].pid).toBe(parentPid);
    expect(counters[1].pid).toBe(childPid);

    const findMainThreadIndexByPid = (pid: number): number =>
      processedProfile.threads.findIndex(
        thread => thread.name === 'GeckoMain' && thread.pid === pid
      );

    expect(counters[0].mainThreadIndex).toBe(
      findMainThreadIndexByPid(parentPid)
    );
    expect(counters[1].mainThreadIndex).toBe(
      findMainThreadIndexByPid(childPid)
    );
  });

  it('offsets the counter timing for child processes', function() {
    const { parentGeckoProfile, parentCounter, childCounter } = setup();
    const processedProfile = processProfile(parentGeckoProfile);
    const processedCounters = ensureExists(processedProfile.counters);

    const originalTime = [0, 1, 2, 3, 4, 5, 6];
    const offsetTime = originalTime.map(n => n + 1000);

    const extractTime = counter =>
      counter.sample_groups.samples.data.map(tuple => tuple[0]);

    // The original times and parent process are not offset.
    expect(extractTime(parentCounter)).toEqual(originalTime);
    expect(extractTime(childCounter)).toEqual(originalTime);
    expect(processedCounters[0].sampleGroups.samples.time).toEqual(
      originalTime
    );

    // The subprocess times are offset when processed:
    expect(processedCounters[1].sampleGroups.samples.time).toEqual(offsetTime);
  });
});

describe('serializeProfile', function() {
  it('should produce a parsable profile string', async function() {
    const profile = processProfile(createGeckoProfile());
    const serialized = serializeProfile(profile);
    expect(JSON.parse.bind(null, serialized)).not.toThrow();
  });

  it('should produce the same profile in a roundtrip', async function() {
    const profile = processProfile(createGeckoProfile());
    const serialized = serializeProfile(profile);
    const roundtrip = await unserializeProfileOfArbitraryFormat(serialized);
    // FIXME: Uncomment this line after resolving `undefined` serialization issue
    // See: https://github.com/firefox-devtools/profiler/issues/1599
    // expect(profile).toEqual(roundtrip);

    const secondSerialized = serializeProfile(roundtrip);
    const secondRountrip = await unserializeProfileOfArbitraryFormat(
      secondSerialized
    );
    expect(roundtrip).toEqual(secondRountrip);
  });
});

describe('js allocation processing', function() {
  function getAllocationMarkerHelper(geckoThread: GeckoThread) {
    let time = 0;
    return ({ byteSize, stackIndex }) => {
      const thisTime = time++;
      // Opt out of type checking, due to the schema look-up not being type checkable.
      const markerTuple: any = [];
      const payload: JsAllocationPayload_Gecko = {
        type: 'JS allocation',
        startTime: thisTime,
        endTime: thisTime,
        className: 'Function',
        typeName: 'JSObject',
        coarseType: 'Object',
        size: byteSize,
        inNursery: true,
        stack: createGeckoMarkerStack({ stackIndex, time: thisTime }),
      };

      markerTuple[geckoThread.markers.schema.name] = 'JS allocation';
      markerTuple[geckoThread.markers.schema.time] = thisTime;
      markerTuple[geckoThread.markers.schema.data] = payload;

      geckoThread.markers.data.push(markerTuple);
    };
  }

  it('should process JS allocation markers into a JS allocation table', function() {
    const geckoProfile = createGeckoProfile();
    const geckoThread = geckoProfile.threads[0];
    const createAllocation = getAllocationMarkerHelper(geckoThread);

    // Verify the test found the parent process' main thread.
    expect(geckoThread.name).toBe('GeckoMain');
    expect(geckoThread.processType).toBe('default');

    // Create 3 allocations, and note the marker lengths.
    const originalMarkersLength = geckoThread.markers.data.length;
    createAllocation({ byteSize: 3, stackIndex: 11 });
    createAllocation({ byteSize: 5, stackIndex: 13 });
    createAllocation({ byteSize: 7, stackIndex: null });
    const markersAndAllocationsLength = geckoThread.markers.data.length;

    // Do a simple assertion to verify that the allocations were added by the test
    // fixture as expected.
    expect(markersAndAllocationsLength).toEqual(originalMarkersLength + 3);

    // Process the profile and get out the new thread.
    const processedProfile = processProfile(geckoProfile);
    const processedThread = processedProfile.threads[0];

    // Check for the existence of the allocations.
    const { jsAllocations } = processedThread;
    if (!jsAllocations) {
      throw new Error('Could not find the jsAllocations on the main thread.');
    }

    // Assert that the transformation makes sense.
    expect(jsAllocations.time).toEqual([0, 1, 2]);
    expect(jsAllocations.duration).toEqual([3, 5, 7]);
    expect(jsAllocations.stack).toEqual([11, 13, null]);
  });
});
