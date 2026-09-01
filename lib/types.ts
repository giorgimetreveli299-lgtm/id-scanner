export type FaceBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Shown when the back upload looks like a front (face / front text, no QR). */
export const BACK_SIDE_REQUIRED_ERROR =
  "Please upload the back side of the driving license.";

/** Shown when the front upload looks like a back (QR / back text, no face). */
export const FRONT_SIDE_REQUIRED_ERROR =
  "Please upload the front side of the driving license.";
