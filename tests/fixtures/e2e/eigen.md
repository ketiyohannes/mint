# Eigenvectors and Eigenvalues: A Short Primer

## Vectors that keep their direction

Most vectors change direction when a matrix multiplies them. A matrix can rotate, shear, or stretch space, and a typical vector ends up pointing somewhere new. A few special vectors are different. When the matrix acts on them, they stay on the same line through the origin and are only stretched or shrunk.

These special vectors are called eigenvectors. The amount of stretching is a number called the eigenvalue. If the eigenvalue is 2, the eigenvector doubles in length. If it is one half, the vector shrinks to half its length. If it is negative, the vector flips to point the other way along the same line.

## The defining equation

The whole idea fits in one equation: A x equals lambda x. Here A is the matrix, x is the eigenvector, and lambda is the eigenvalue. The equation says that multiplying x by the matrix gives the same result as multiplying x by a single number.

Because x must not be the zero vector, the equation only has solutions for special values of lambda. Rewriting it as (A minus lambda I) x equals zero shows why: the matrix A minus lambda I must squash some direction to zero, so its determinant must be zero.

- The characteristic equation is det(A minus lambda I) equals 0.
- Its roots are the eigenvalues.
- For each eigenvalue, the eigenvectors fill a line or plane called the eigenspace.

## Why they matter

Eigenvectors reveal the natural axes of a transformation. Along these axes the matrix acts like simple scaling, which makes repeated multiplication easy to predict. After many steps, the direction with the largest eigenvalue usually dominates, which is the idea behind ranking web pages and finding the main patterns in data.

> A matrix is easiest to understand in the coordinate system of its eigenvectors.

In principal component analysis, the eigenvectors of a covariance matrix point along the directions where the data varies most, and the eigenvalues measure how much variation lies along each one.
