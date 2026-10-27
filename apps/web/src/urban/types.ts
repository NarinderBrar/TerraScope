export type XY = [number, number];
export interface UrbanFeature {
  id: string;
  kind: 'road' | 'building' | 'tree' | 'bus-stop' | 'crossing' | 'signal';
  name: string;
  points: XY[];
  tags: Record<string, string>;
  height: number;
  heightAssumed: boolean;
}
export interface UrbanData { features: UrbanFeature[]; fetchedAt: string; sceneId: string }
export interface UrbanOptions {
  traffic: boolean; buildings: boolean; vegetation: boolean; transit: boolean; shade: boolean;
  playing: boolean; demand: number; hour: number; date: string;
  scenario: 'baseline' | 'diversion' | 'signals' | 'bus-lane' | 'trees';
  selectedRoad: string;
}
export interface RoadResult {
  feature: UrbanFeature; a: XY; b: XY; length: number;
  capacity: number; volume: number; speed: number; freeSpeed: number; load: number;
}
export interface TrafficResult {
  roads: RoadResult[]; delay: number; peakLoad: number; trips: number; unserved: number;
}
export interface ShadeCell { point: XY; shaded: boolean }
export interface ShadeResult {
  cells: ShadeCell[]; percent: number | null; canopyPercent: number | null;
  sunAltitude: number; sunAzimuth: number; plannedTrees: XY[];
}
export interface UrbanOverlayState {
  data: UrbanData; options: UrbanOptions; traffic: TrafficResult; shade: ShadeResult;
  selectedFeature: string;
}
export const DEFAULT_URBAN_OPTIONS: UrbanOptions = {
  traffic: true, buildings: false, vegetation: true, transit: true, shade: false,
  playing: true, demand: 600, hour: 15, date: new Date().toISOString().slice(0, 10),
  scenario: 'baseline', selectedRoad: '',
};
