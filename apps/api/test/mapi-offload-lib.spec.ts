import {
  compactDepthToMids,
  parseFirstLevelMidFromDepthValue,
  parseJsonPreservingLargeIds,
  protectLargeIdsInJson,
} from '../src/modules/trade/mapi-offload-lib';

describe('mapi-offload-lib', () => {
  it('protects 16+ digit order ids before parse', () => {
    const raw = '{"orderID": 8389766251307928000,"qty":1}';
    expect(protectLargeIdsInJson(raw)).toContain('"orderID":"8389766251307928000"');
    expect(parseJsonPreservingLargeIds(raw).orderID).toBe('8389766251307928000');
  });

  it('compacts GetDepth arrays to first-level mids', () => {
    const depth = {
      TUT_PC_BAC: [0, 0.04, 10, 0.039, 12],
      BTC_PC_BAC: [0, 70000, 1, 69990, 1],
    };
    const mids = compactDepthToMids(depth);
    expect(mids.TUT_PC_BAC).toBeCloseTo(0.0395);
    expect(mids.BTC_PC_BAC).toBeCloseTo(69995);
    expect(parseFirstLevelMidFromDepthValue(mids.TUT_PC_BAC)).toBeCloseTo(0.0395);
  });
});
