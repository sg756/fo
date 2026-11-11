/** 批量补 Gas 结束后给操作者看的结果。有没打出去的，提示稍后再点一次。 */
export function fundGasDoneNotice(done: any): { text: string; kind: 'ok' | 'err'; ms: number } {
  const funded = Number(done?.funded || 0);
  const failed = Number(done?.failed || 0);
  const missed = Number(done?.unqueried || 0);
  const retry =
    failed > 0 || missed > 0 || /请稍等后再点/.test(String(done?.message || ''));
  const text =
    done?.message ||
    `补 Gas 完成：成功 ${funded} 笔，失败 ${failed} 笔${
      missed > 0 ? `，${missed} 个地址没查到余额` : ''
    }${retry ? '。请稍等后再点一次「批量补 Gas」' : ''}`;
  return { text, kind: retry ? 'err' : 'ok', ms: retry ? 8000 : 5000 };
}
