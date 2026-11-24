import {expect,it} from 'vitest'
import {validateBrainRequest} from './validate'
import {brainBriefing} from './format'
import {HARBOR_RECALL} from './__fixtures__/recall'
const [from,to]=HARBOR_RECALL.entities
const memory=HARBOR_RECALL.hits[0]!.memory
const link={...memory.links[0]!,label:'<owns>', validFrom:null,validTo:null,statedBy:'agent' as const}
it('accepts only the three search moves',()=>{
 for(const params of [{query:'Ledger'},{from:'Harbor',context:['Ledger']},{from:'Harbor',to:'Ledger'}]) expect(validateBrainRequest('search',params)).toEqual(params)
 for(const params of [{},{query:'Ledger',from:'Harbor'},{to:'Ledger'},{context:[]},{from:'Harbor',to:'Ledger',context:[]},{from:'Harbor',context:Array(6).fill('Ledger')}]) expect(()=>validateBrainRequest('search',params)).toThrow()
})
it('validates a cited relationship',()=>{
 const params={subjectId:'rina',predicate:'owns',objectId:'harbor',label:'owns billing for',memoryIds:['ownership'],reason:'The memories agree.'}; expect(validateBrainRequest('relate',params)).toEqual(params)
 for(const patch of [{objectId:'rina'},{label:'x'.repeat(81)},{since:'2026-02-31'},{memoryIds:[]},{memoryIds:Array(9).fill('ownership')}]) expect(()=>validateBrainRequest('relate',{...params,...patch})).toThrow()
})
it('expands a name with cited, escaped relationship sentences',()=>{
 const result=brainBriefing({mode:'expand',status:'ok',entity:from!,alternatives:[],current:[{link,other:to!,supports:1}],ended:[],together:[],togetherMore:0,hits:HARBOR_RECALL.hits, entities:HARBOR_RECALL.entities,degradation:[]});expect(result.text).toContain('Now:\n- Rina Okafor &lt;owns&gt; Harbor [1]');expect(result.refs.get(1)).toBe(memory.id)
})
it('prints a route with the cited memories and never breaks the cap',()=>{
 const result=brainBriefing({mode:'route',status:'ok',from:from!,to:to!,routes:[[{kind:'relation',link}]],memories:[memory],entities:HARBOR_RECALL.entities});expect(result.text).toContain('Routes from Rina Okafor to Harbor:\n1. Rina Okafor &lt;owns&gt; Harbor [1]');expect(result.text.length).toBeLessThanOrEqual(6000);expect(result.refs.get(1)).toBe(memory.id)
})
it('prints plain metadata on each search line',()=>{expect(brainBriefing(HARBOR_RECALL).text).toContain('fact · still true · you said it · told · 2 lanes · important')})
