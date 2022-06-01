// import { ArrayVector, DataFrame, FieldType, Field } from '@grafana/data';
import { ArrayVector, DataFrame, FieldType, Field } from '../..';
import { TimeRange } from '../../types';

type InsertMode = (prev: number, next: number, threshold: number) => number;

const INSERT_MODES = {
  threshold: (prev: number, next: number, threshold: number) => prev + threshold,
  midpoint: (prev: number, next: number, threshold: number) => (prev + next) / 2,
  // previous time + 1ms to prevent StateTimeline from forward-interpolating prior state
  plusone: (prev: number, next: number, threshold: number) => prev + 1,
};

function getRefField(frame: DataFrame, refFieldName?: string | null) {
  return frame.fields.find((field) => {
    return refFieldName != null ? field.name === refFieldName : field.type === FieldType.time;
  });
}

interface NullInsertOptions {
  frame: DataFrame;
  refFieldName?: string;
  refFieldPseudoMax?: number;
  refFieldPseudoMin?: number;
  insertMode?: InsertMode;
}

/**
 * @internal exposed while we migrate grafana UI
 */
export function applyNullInsertThreshold(opts: NullInsertOptions): DataFrame {
  if (opts.frame.length === 0) {
    return opts.frame;
  }

  let { frame, refFieldName, refFieldPseudoMax, refFieldPseudoMin, insertMode } = opts;
  if (!insertMode) {
    insertMode = INSERT_MODES.threshold;
  }

  const refField = getRefField(frame, refFieldName);
  if (refField == null) {
    return frame;
  }

  const thresholds = frame.fields.map((field) => {
    // NOTE: This value at the end is default threshold, what should it be when we don't have a value?
    return field.config.custom?.insertNulls ?? refField.config.interval ?? null;
  });

  const uniqueThresholds = new Set<number>(thresholds);

  uniqueThresholds.delete(null as any);

  if (uniqueThresholds.size === 0) {
    return frame;
  }

  if (uniqueThresholds.size === 1) {
    const threshold = uniqueThresholds.values().next().value;

    if (threshold <= 0) {
      return frame;
    }

    const refValues = refField.values.toArray();

    const frameValues = frame.fields.map((field) => field.values.toArray());

    const filledFieldValues = nullInsertThreshold(
      refValues,
      frameValues,
      threshold,
      refFieldPseudoMax,
      refFieldPseudoMin,
      insertMode,
      true
    );

    if (filledFieldValues === frameValues) {
      return frame;
    }

    return {
      ...frame,
      length: filledFieldValues[0].length,
      fields: frame.fields.map((field, i) => ({
        ...field,
        values: new ArrayVector(filledFieldValues[i]),
      })),
    };
  }

  // TODO: unique threshold-per-field (via overrides) is unimplemented
  // should be done by processing each (refField + thresholdA-field1 + thresholdA-field2...)
  // as a separate nullInsertThreshold() dataset, then re-join into single dataset via join()
  return frame;
}

/**
 * @internal exposed while we migrate grafana UI
 */
function nullInsertThreshold(
  refValues: number[],
  frameValues: any[][],
  threshold: number,
  // will insert a trailing null when refFieldPseudoMax > last datapoint + threshold
  refFieldPseudoMax: number | null = null,
  // will insert a leading null when refFieldPseudoMin < first datapoint
  refFieldPseudoMin: number | null = null,
  getInsertValue: InsertMode,
  // will insert the value at every missing interval
  thorough: boolean
) {
  const len = refValues.length;
  let prevValue: number = refValues[0];
  const refValuesNew: number[] = [];

  // Insert a frame time at the beginning of the sequence if the previous value
  // minus the threshold is greater than the minimum
  if (refFieldPseudoMin != null) {
    let minValue = refFieldPseudoMin;

    while (minValue <= prevValue) {
      let nextValue = minValue + threshold;
      refValuesNew.push(getInsertValue(minValue, nextValue, threshold));
      minValue = nextValue;
    }
  }

  // Insert the initial value from the original sequence
  refValuesNew.push(prevValue);

  // Insert frame times throughout the sequence when the
  // current value minus the previus value is greater
  // than the threshold
  for (let i = 1; i < len; i++) {
    const curValue = refValues[i];

    while (curValue - prevValue > threshold) {
      refValuesNew.push(getInsertValue(prevValue, curValue, threshold));

      prevValue += threshold;

      if (!thorough) {
        break;
      }
    }

    refValuesNew.push(curValue);

    prevValue = curValue;
  }

  // Insert a frame time at the end of the sequence if the previous value
  // plus the threshold is greater than the maximum
  if (refFieldPseudoMax != null) {
    while (prevValue + threshold <= refFieldPseudoMax) {
      refValuesNew.push(getInsertValue(prevValue, refFieldPseudoMax, threshold));
      prevValue += threshold;
    }
  }

  // Retrieve the new length, if we didn't fill
  // any nulls return the original values
  const filledLen = refValuesNew.length;
  if (filledLen === len) {
    return frameValues;
  }

  // Fill in nulls as appropriate
  const filledFieldValues: any[][] = [];
  for (let fieldValues of frameValues) {
    let filledValues;

    if (fieldValues !== refValues) {
      filledValues = Array(filledLen);

      for (let i = 0, j = 0; i < filledLen; i++) {
        filledValues[i] = refValues[j] === refValuesNew[i] ? fieldValues[j++] : null;
      }
    } else {
      filledValues = refValuesNew;
    }

    filledFieldValues.push(filledValues);
  }

  return filledFieldValues;
}

/**
 * will mutate the DataFrame's fields' values
 *
 * @internal exposed while we migrate grafana UI
 */
export function applySpanNullsThresholds(frame: DataFrame, isFieldVisible: (f: Field) => boolean) {
  let refField = frame.fields.find((field) => field.type === FieldType.time); // this doesnt need to be time, just any numeric/asc join field
  let refValues = refField?.values.toArray() as any[];

  for (let i = 0; i < frame.fields.length; i++) {
    let field = frame.fields[i];

    if (field === refField || isFieldVisible(field)) {
      continue;
    }

    let spanNulls = field.config.custom?.spanNulls;

    if (typeof spanNulls === 'number') {
      if (spanNulls !== -1) {
        field.values = new ArrayVector(nullToUndefThreshold(refValues, field.values.toArray(), spanNulls));
      }
    }
  }

  return frame;
}

/**
 * Replace null values with configured replacement.
 */
function nullToValue(frame: DataFrame) {
  frame.fields.forEach((f, fi) => {
    const noValue = +f.config?.noValue!;
    if (!Number.isNaN(noValue)) {
      const values = f.values.toArray();
      for (let i = 0; i < values.length; i++) {
        if (values[i] === null) {
          values[i] = noValue;
        }
      }

      console.log(values);

      // delete f.state?.calcs; // force recalculation of stats;
    }
  });

  return frame;
}

// mutates all nulls -> undefineds in the fieldValues array for value-less refValues ranges below maxThreshold
// refValues is typically a time array and maxThreshold is the allowable distance between in time
export function nullToUndefThreshold(refValues: number[], fieldValues: any[], maxThreshold: number): any[] {
  let prevRef;
  let nullIdx;

  for (let i = 0; i < fieldValues.length; i++) {
    let fieldVal = fieldValues[i];

    if (fieldVal == null) {
      if (nullIdx == null && prevRef != null) {
        nullIdx = i;
      }
    } else {
      if (nullIdx != null) {
        if (refValues[i] - (prevRef as number) < maxThreshold) {
          while (nullIdx < i) {
            fieldValues[nullIdx++] = undefined;
          }
        }

        nullIdx = null;
      }

      prevRef = refValues[i];
    }
  }

  return fieldValues;
}

/**
 * Used by state timeline to process null values.
 */
export function processNullValues(frames: DataFrame[], timeRange: TimeRange): DataFrame[] {
  return frames.map((frame) => {
    // console.log(frame);

    // Insert nulls
    let f = applyNullInsertThreshold({
      frame,
      refFieldPseudoMin: timeRange.from.valueOf(),
      refFieldPseudoMax: timeRange.to.valueOf(),
    });

    // console.log(f);

    // Convert null to the configured value
    f = nullToValue(f);

    // console.log(f);

    //return applySpanNullsThresholds(f, () => true);
    return f;
  });
}