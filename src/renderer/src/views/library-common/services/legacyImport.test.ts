import { describe, expect, it } from 'vitest'

import { detectLegacyNodeType } from './legacyImport'

describe('detectLegacyNodeType', () => {
  it('按 T3D 代码特征分出蓝图和材质', () => {
    expect(detectLegacyNodeType('BPGraph(Name="x")')).toBe('蓝图函数')
    expect(detectLegacyNodeType('MaterialExpressionFunctionOutput')).toBe('材质函数')
    expect(detectLegacyNodeType('Begin Object Class=/Script/Engine.MaterialGraph')).toBe('材质节点')
    expect(detectLegacyNodeType('Begin Object Class=/Script/BlueprintGraph.K2Node')).toBe(
      '蓝图节点'
    )
  })

  it('code 是 NULL 或空时归到脚本代码，不抛异常', () => {
    // 旧库里确实有 code 为空的行，`readAllLegacyNodes` 不筛类型、会原样带上来。
    // 这里抛的话，整个导入预览直接报错 —— 用户连「有多少条可导」都看不到
    expect(detectLegacyNodeType(null)).toBe('脚本代码')
    expect(detectLegacyNodeType(undefined)).toBe('脚本代码')
    expect(detectLegacyNodeType('')).toBe('脚本代码')
  })
})
